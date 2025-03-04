import { HardwareInfo, removePad, ServerInfo } from '@dash/common';
import { exec as cexec } from 'child_process';
import * as fs from 'fs';
import { BehaviorSubject, map, Observable } from 'rxjs';
import * as si from 'systeminformation';
import { inspect, promisify } from 'util';
import { CONFIG } from './config';
import { NET_INTERFACE_PATH } from './setup';

const exec = promisify(cexec);

const normalizeCpuModel = (cpuModel: string) => {
  return cpuModel
    .replace(/Processor/g, '')
    .replace(/[A-Za-z0-9]*-Core/g, '')
    .trim();
};

const normalizeGpuBrand = (brand: string) => {
  return brand ? brand.replace(/(corporation)/gi, '').trim() : undefined;
};

const normalizeGpuName = (name: string) => {
  return name ? name.replace(/(nvidia|amd|intel)/gi, '').trim() : undefined;
};

const normalizeGpuModel = (model: string) => {
  return model ? model.replace(/\[.*\]/gi, '').trim() : undefined;
};

const STATIC_INFO = new BehaviorSubject<HardwareInfo>({
  os: {
    arch: '',
    distro: '',
    kernel: '',
    platform: '',
    release: '',
    uptime: 0,
  },
  cpu: {
    brand: '',
    model: '',
    cores: 0,
    threads: 0,
    frequency: 0,
  },
  ram: {
    size: 0,
    layout: [],
  },
  storage: {
    layout: [],
  },
  network: {
    interfaceSpeed: 0,
    speedDown: 0,
    speedUp: 0,
    type: '',
    publicIp: '',
  },
  gpu: {
    layout: [],
  },
});

const loadOsInfo = async (): Promise<void> => {
  const info = await si.osInfo();

  STATIC_INFO.next({
    ...STATIC_INFO.getValue(),
    os: {
      arch: info.arch,
      distro: info.distro,
      kernel: info.kernel,
      platform: info.platform,
      release:
        info.release === 'unknown' ? info.build || 'unknown' : info.release,
      uptime: 0,
    },
  });
};

const loadCpuInfo = async (): Promise<void> => {
  const info = await si.cpu();

  STATIC_INFO.next({
    ...STATIC_INFO.getValue(),
    cpu: {
      brand: info.manufacturer,
      model: normalizeCpuModel(info.brand),
      cores: info.physicalCores,
      threads: info.cores,
      frequency: info.speed,
    },
  });
};

const loadRamInfo = async (): Promise<void> => {
  const [info, layout] = await Promise.all([si.mem(), si.memLayout()]);

  STATIC_INFO.next({
    ...STATIC_INFO.getValue(),
    ram: {
      size: info.total,
      layout: layout.map(({ manufacturer, type, clockSpeed }) => ({
        brand: manufacturer,
        type: type,
        frequency: clockSpeed ?? undefined,
      })),
    },
  });
};

export const mapToStorageLayout = (
  disks: si.Systeminformation.DiskLayoutData[],
  blocks: si.Systeminformation.BlockDevicesData[],
  sizes: si.Systeminformation.FsSizeData[]
) => {
  const raidMembers = blocks.filter(block => block.fsType.endsWith('_member'));
  const blockDisks = blocks.filter(
    block =>
      block.type === 'disk' &&
      block.size > 0 &&
      !CONFIG.fs_device_filter.includes(block.name)
  );

  const blockLayout = blockDisks
    .map(disk => {
      const device = disk.name;
      const diskRaidMem = raidMembers.filter(member =>
        member.name.startsWith(device)
      );
      const nativeDisk = disks.find(
        d => disk.model != '' && d.name === disk.model
      ) ?? {
        vendor: disk.name,
        size: disk.size,
        type: disk.physical,
      };

      if (diskRaidMem.length > 0) {
        const isSplit = diskRaidMem[0].label.includes(':');

        let label: string;
        if (isSplit) {
          const splitLabel = diskRaidMem[0].label.split(':')[0];
          const hasUniqueName = !raidMembers.some(member => {
            const startSame = member.label.split(':')[0] === splitLabel;
            const isSame = member.label === diskRaidMem[0].label;

            return startSame && !isSame;
          });
          label = hasUniqueName ? splitLabel : diskRaidMem[0].label;
        } else {
          label = diskRaidMem[0].label;
        }

        return {
          device: device,
          brand: nativeDisk.vendor,
          size: nativeDisk.size,
          type: nativeDisk.type,
          raidGroup: label,
        };
      } else {
        return {
          device: device,
          brand: nativeDisk.vendor,
          size: nativeDisk.size,
          type: nativeDisk.type,
        };
      }
    })
    .filter(d => d != null);

  const sizesLayout = CONFIG.fs_virtual_mounts
    .map(mount => {
      const size = sizes.find(s => s.fs === mount);

      return size
        ? {
            device: size.fs,
            brand: size.fs,
            type: 'VIRTUAL',
            size: size.size,
            virtual: true,
          }
        : undefined;
    })
    .filter(d => d != null);

  return blockLayout.concat(sizesLayout);
};

const loadStorageInfo = async (): Promise<void> => {
  const [disks, blocks, sizes] = await Promise.all([
    si.diskLayout(),
    si.blockDevices(),
    si.fsSize(),
  ]);

  STATIC_INFO.next({
    ...STATIC_INFO.getValue(),
    storage: {
      layout: mapToStorageLayout(disks, blocks, sizes),
    },
  });
};

const loadNetworkInfo = async (): Promise<void> => {
  if (NET_INTERFACE_PATH) {
    const isWireless = fs.existsSync(`${NET_INTERFACE_PATH}/wireless`);
    const isBridge = fs.existsSync(`${NET_INTERFACE_PATH}/bridge`);
    const isBond = fs.existsSync(`${NET_INTERFACE_PATH}/bonding`);
    const isTap = fs.existsSync(`${NET_INTERFACE_PATH}/tun_flags`);

    STATIC_INFO.next({
      ...STATIC_INFO.getValue(),
      network: {
        ...STATIC_INFO.getValue().network,
        type: isWireless
          ? 'Wireless'
          : isBridge
          ? 'Bridge'
          : isBond
          ? 'Bond'
          : isTap
          ? 'TAP'
          : 'Wired',
      },
    });

    // Wireless networks have no fixed Interface speed
    if (!isWireless) {
      const { stdout } = await exec(`cat ${NET_INTERFACE_PATH}/speed`);
      const numValue = Number(stdout.trim());

      STATIC_INFO.next({
        ...STATIC_INFO.getValue(),
        network: {
          ...STATIC_INFO.getValue().network,
          interfaceSpeed: isNaN(numValue) || numValue === -1 ? 0 : numValue,
        },
      });
    }
  } else {
    const networkInfo = await si.networkInterfaces();
    //@ts-ignore
    const defaultNet = networkInfo.find(net => net.default)!;

    STATIC_INFO.next({
      ...STATIC_INFO.getValue(),
      network: {
        ...STATIC_INFO.getValue().network,
        type: defaultNet.type,
        interfaceSpeed: defaultNet.speed,
      },
    });
  }
};

const loadGpuInfo = async (): Promise<void> => {
  const info = await si.graphics();

  STATIC_INFO.next({
    ...STATIC_INFO.getValue(),
    gpu: {
      layout: info.controllers.map(controller => ({
        brand: normalizeGpuBrand(controller.vendor),
        model:
          normalizeGpuName(controller.name) ??
          normalizeGpuModel(controller.model),
        memory: controller.memoryTotal ?? controller.vram ?? 0,
      })),
    },
  });
};

const commandExists = async (command: string): Promise<boolean> => {
  try {
    const { stdout, stderr } = await exec(`which ${command}`);
    return stderr === '' && stdout.trim() !== '';
  } catch (e) {
    return false;
  }
};

export const runSpeedTest = async (): Promise<string> => {
  let usedRunner: string;
  if (CONFIG.accept_ookla_eula && (await commandExists('speedtest'))) {
    usedRunner = 'ookla';
    const { stdout } = await exec('speedtest -f json');
    const json = JSON.parse(stdout);

    STATIC_INFO.next({
      ...STATIC_INFO.getValue(),
      network: {
        ...STATIC_INFO.getValue().network,
        speedDown:
          json.download.bandwidth * 8 ??
          STATIC_INFO.getValue().network.speedDown,
        speedUp:
          json.upload.bandwidth * 8 ?? STATIC_INFO.getValue().network.speedUp,
        publicIp:
          json.interface.externalIp ?? STATIC_INFO.getValue().network.publicIp,
      },
    });
  } else if (await commandExists('speedtest-cli')) {
    usedRunner = 'speedtest-cli';
    const { stdout } = await exec('speedtest-cli --json --secure');
    const json = JSON.parse(stdout);

    STATIC_INFO.next({
      ...STATIC_INFO.getValue(),
      network: {
        ...STATIC_INFO.getValue().network,
        speedDown: json.download ?? STATIC_INFO.getValue().network.speedDown,
        speedUp: json.upload ?? STATIC_INFO.getValue().network.speedUp,
        publicIp: json.client.ip ?? STATIC_INFO.getValue().network.publicIp,
      },
    });
  } else {
    throw new Error(removePad`
      There is no speedtest module installed - please use one of the following:
      - speedtest: https://www.speedtest.net/apps/cli
      - speedtest-cli: https://github.com/sivel/speedtest-cli

      For more help on how to setup dashdot, look here:
      https://getdashdot.com/docs/install/from-source
    `);
  }

  return usedRunner;
};

const promIf = (condition: boolean, func: () => Promise<any>): Promise<any> => {
  return condition ? func() : Promise.resolve(null);
};

export const loadStaticServerInfo = async (): Promise<void> => {
  await Promise.allSettled([
    promIf(CONFIG.widget_list.includes('os'), loadOsInfo),
    promIf(CONFIG.widget_list.includes('cpu'), loadCpuInfo),
    promIf(CONFIG.widget_list.includes('ram'), loadRamInfo),
    promIf(CONFIG.widget_list.includes('storage'), loadStorageInfo),
    promIf(CONFIG.widget_list.includes('network'), loadNetworkInfo),
    promIf(CONFIG.widget_list.includes('gpu'), loadGpuInfo),
  ]);

  console.log(
    'Static Server Info:',
    inspect(getStaticServerInfo(), {
      showHidden: false,
      depth: null,
      colors: true,
    })
  );
};

export const getStaticServerInfo = (): ServerInfo => {
  return {
    ...STATIC_INFO.getValue(),
    os: {
      ...STATIC_INFO.getValue().os,
      uptime: +si.time().uptime,
    },
    config: CONFIG,
  };
};

export const getStaticServerInfoObs = (): Observable<ServerInfo> => {
  return STATIC_INFO.pipe(
    map(info => ({
      ...info,
      os: {
        ...info.os,
        uptime: +si.time().uptime,
      },
      config: CONFIG,
    }))
  );
};
