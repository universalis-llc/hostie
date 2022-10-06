## Build alpine linux kernel and sources
```sh
apk add git alpine-sdk
git clone --depth=1 https://git.alpinelinux.org/aports -b v3.16.2
cd aports/main/linux-lts/
echo "Adding VFIO MDEV support to kernel config"
echo "CONFIG_VFIO_MDEV=m" >> lts.x86_64.config
echo "CONFIG_NETCONSOLE=y" >> lts.x86_64.config
echo "CONFIG_KEXEC=y" >> lts.x86_64.config
echo "CONFIG_FW_LOADER_COMPRESS=y" >> lts.x86_64.config
echo -e "CONFIG_HZ_100=y\nCONFIG_HZ=100\nCONFIG_HZ_300=n" >> lts.x86_64.config
abuild-keygen -aqn
abuild -F checksum
abuild -Fr
cd ../linux-headers
abuild -F checksum
abuild -Fr
```

## Make alpine image
```sh
export MIRROR=(https://master1.node.universalis.dev/repo/alpine/v3.16/main https://dl-cdn.alpinelinux.org/alpine/v3.16/main https://dl-cdn.alpinelinux.org/alpine/v3.16/community)
export CHROOT=/tmp/alpine-image
apk add -X ${MIRROR[0]} -X ${MIRROR[1]} -U --allow-untrusted -p ${CHROOT} --initdb alpine-base
mount -o bind /dev ${CHROOT}/dev
mount -t proc none ${CHROOT}/proc
mount -o bind /sys ${CHROOT}/sys
echo "nameserver 1.1.1.1\nnameserver 1.0.0.1\nnameserver 2620:fe::fe\nnameserver 2620:fe::9\nnameserver 8.8.8.8" > ${CHROOT}/etc/resolv.conf
mkdir -p ${CHROOT}/etc/apk
printf "%s\n" "${MIRROR[@]}" > ${CHROOT}/etc/apk/repositories
chroot ${CHROOT} /bin/ash -l
```

## Make initramfs
```
mkinitfs -F "ata base ide scsi usb virtio ext4 nvme" -i /srv/http/boot/alpine/init -o initramfs-lts
```

## Make netboot img
```
./mkimage.sh --arch x86_64 --profile netboot --outdir /tmp --repository http://master1.node.universalis.dev/repo/alpine/v3.16/main --extra-repository http://dl-cdn.alpinelinux.org/alpine/v3.16/main
```

## Create alpine repository the manual way
```sh
apk index -o APKINDEX.unsigned.tar.gz *.apk
openssl dgst -sha1 -sign ~/.abuild/ayrton.sparling@universalis.dev -out .SIGN.RSA.repo.universalis.dev APKINDEX.unsigned.tar.gz
tar -c .SIGN.RSA.repo.universalis.dev | abuild-tar --cut | gzip -9 > signature.tar.gz
cat signature.tar.gz APKINDEX.unsigned.tar.gz > APKINDEX.tar.gz
```

## Create alpine repository the easy way
```sh
apk index -o APKINDEX.tar.gz *.apk
abuild-sign -k ~/.abuild/ayrton.sparling@universalis.dev APKINDEX.tar.gz
```

## QEMU performance enchancements
`trustGuestRxFilters="yes"` allows multicast and fixes ipv6 in guests
```xml
<domain type="kvm">
<features>
  <hyperv mode="custom">
    <relaxed state="on"/>
    <vapic state="on"/>
    <spinlocks state="on" retries="8191"/>
    <vpindex state="on"/>
    <synic state="on"/>
    <frequencies state="on"/>
    <reenlightenment state="on"/>
    <tlbflush state="on"/>
  </hyperv>
  <vmport state='off'/>
  <ioapic driver='kvm'/>
  <kvm>
    <hint-dedicated state='off'/>
  </kvm>
</features>
<pm>
  <suspend-to-disk enabled='no'/>
  <suspend-to-mem enabled='yes'/>
</pm>
<cpu mode='host-model' check='full'>
  <topology sockets='1' cores='4' threads='2'/>
  <cache mode='passthrough'/>
  <feature policy='require' name='svm'/>
  <feature policy='require' name='hypervisor'/>
  <feature policy='require' name='apic'/>
  <feature policy='require' name='topoext'/>
</cpu>
<devices>
  <interface type="direct" trustGuestRxFilters="yes">
    <mac address="52:54:00:d5:e8:03"/>
    <source dev="eth0" mode="bridge"/>
    <target dev="macvtap73"/>
    <model type="virtio"/>
    <alias name="net0"/>
    <address type="pci" domain="0x0000" bus="0x01" slot="0x00" function="0x0"/>
  </interface>
</devices>
<clock>
  <timer name='tsc' present='yes' mode='native'/>
</clock>
```

Mdev make device:
```
mdevctl start -u 4b20d080-1b54-4048-85b3-a6a62d165c01 -p 0000:07:00.0 -t nvidia-902
echo 4b20d080-1b54-4048-85b3-a6a62d165c01 > /sys/devices/pci0000:00/0000:00:03.1/0000:07:00.0/mdev_supported_types/nvidia-902/create
```

Libvirt Mdev device:
`virsh -c "qemu+ssh://root@[2605:a601:a7ab:3901:aaa1:59ff:fe9c:b269]/system" nodedev-define ./mdev_node.xml`
```xml
<device>
  <name>mdev</name>
  <parent>computer</parent>
  <capability type='mdev'>
    <type id='nvidia-904'/>
    <uuid>4b20d080-1b54-4048-85b3-a6a62d165c01</uuid>
  </capability>
</device>
```

## Manual VFIO
```xml
<domain type='kvm' xmlns:qemu='http://libvirt.org/schemas/domain/qemu/1.0'>
  <qemu:commandline>
    <qemu:arg value="-device"/>
    <qemu:arg value="vfio-pci,sysfsdev=/sys/bus/mdev/devices/4b20d080-1b54-4048-85b3-a6a62d165c01,ramfb=on,display=on,id=hostpci0.0,addr=0x6.0,x-pci-vendor-id=0x10de,x-pci-device-id=0x17F0,x-pci-sub-vendor-id=0x10de,x-pci-sub-device-id=0x11A0"/>
    <qemu:arg value="-uuid"/>
    <qemu:arg value="4b20d080-1b54-4048-85b3-a6a62d165c01"/>
  </qemu:commandline>
</domain>
```

## Installing MLNX_OFED
https://network.nvidia.com/products/infiniband-drivers/linux/mlnx_ofed/
```sh
apk add automake autoconf ethtool bash rpm2cpio kmod
wget https://content.mellanox.com/ofed/MLNX_OFED-5.6-2.0.9.0/MLNX_OFED_LINUX-5.6-2.0.9.0-rhel9.0-x86_64.tgz
tar -xf MLNX_OFED_LINUX-5.6-2.0.9.0-rhel9.0-x86_64.tgz
cd MLNX_OFED_LINUX-5.6-2.0.9.0-rhel9.0-x86_64/RPMS
rpm2cpio mlnx-ofa_kernel-source-5.6-OFED.5.6.2.0.9.1.rhel9u0.x86_64.rpm | cpio -id
cd usr/src/mlnx-ofa_kernel-5.6
# sed -i 's/#!\/usr\/bin\/sh/#!\/bin\/bash/' compat/configure
cd compat
bash autogen.sh
cd ../
ln -s /bin/bash /usr/bin/bash
bash ./configure --with-core-mod --with-ipoib-mod --with-ipoib-cm --with-ipoib-allmulti --with-ipoib_debug-mod --with-srp-mod --with-rxe-mod --with-user_mad-mod --with-user_access-mod --with-addr_trans-mod --with-mlx5-mod --with-mlx5_core-mod --with-mlx5_inf-mod --with-mlx5_debug-mod --with-mlxfw-mod --with-mlx5-ipsec --with-iser-mod --with-isert-mod --without-madeye-mod --without-memtrack --with-debug-info --with-nfsrdma-mod --with-scsi_transport_srp-mod --without-odp --with-wqe-format --with-pa-mr --with-nvmf_host-mod --with-nvmf_target-mod --with-mlxdevm-mod --with-gds
make -j32
rmmod -r mlx4_core
make install_modules
```

### Errors
Cause:
```
failed to setup container for group 16: No available IOMMU models
```
Solution: `modprobe vfio_iommu_type1 vfio_pci`

## KVM
```xml
<domain type="kvm">
  <name>win11</name>
  <uuid>4b93d467-49a4-4b9d-8ae4-37033fc358a3</uuid>
  <metadata>
    <libosinfo:libosinfo xmlns:libosinfo="http://libosinfo.org/xmlns/libvirt/domain/1.0">
      <libosinfo:os id="http://microsoft.com/win/10"/>
    </libosinfo:libosinfo>
  </metadata>
  <memory unit="KiB">8388608</memory>
  <currentMemory unit="KiB">8388608</currentMemory>
  <vcpu placement="static">8</vcpu>
  <os>
    <type arch="x86_64" machine="pc-q35-7.0">hvm</type>
    <loader readonly="yes" type="pflash">/usr/share/qemu/edk2-x86_64-code.fd</loader>
    <nvram>/var/lib/libvirt/qemu/nvram/win11_VARS.fd</nvram>
  </os>
  <features>
    <acpi/>
    <apic/>
    <hyperv mode="custom">
      <relaxed state="on"/>
      <vapic state="on"/>
      <spinlocks state="on" retries="8191"/>
      <vpindex state="on"/>
      <synic state="on"/>
      <frequencies state="on"/>
      <reenlightenment state="on"/>
      <tlbflush state="on"/>
    </hyperv>
    <kvm>
      <hint-dedicated state="off"/>
    </kvm>
    <vmport state="off"/>
    <ioapic driver="kvm"/>
  </features>
  <cpu mode="host-passthrough" check="none" migratable="on">
    <topology sockets="1" dies="1" cores="4" threads="2"/>
  </cpu>
  <clock offset="localtime">
    <timer name="rtc" tickpolicy="catchup"/>
    <timer name="pit" tickpolicy="delay"/>
    <timer name="hpet" present="no"/>
    <timer name="hypervclock" present="yes"/>
    <timer name="tsc" present="yes"/>
  </clock>
  <on_poweroff>destroy</on_poweroff>
  <on_reboot>restart</on_reboot>
  <on_crash>destroy</on_crash>
  <pm>
    <suspend-to-mem enabled="yes"/>
    <suspend-to-disk enabled="no"/>
  </pm>
  <devices>
    <emulator>/usr/bin/qemu-system-x86_64</emulator>
    <disk type="file" device="cdrom">
      <driver name="qemu" type="raw"/>
      <source file="/mnt/isos/Windows_11_Pro_Enterprise_22621.317.iso"/>
      <target dev="sda" bus="sata"/>
      <readonly/>
      <boot order="1"/>
      <address type="drive" controller="0" bus="0" target="0" unit="0"/>
    </disk>
    <disk type="file" device="cdrom">
      <driver name="qemu" type="raw"/>
      <source file="/mnt/isos/virtio-win-0.1.217.iso"/>
      <target dev="sdb" bus="sata"/>
      <readonly/>
      <address type="drive" controller="0" bus="0" target="0" unit="1"/>
    </disk>
    <disk type="file" device="disk">
      <driver name="qemu" type="qcow2"/>
      <source file="/storage/win10.qcow2"/>
      <target dev="vda" bus="virtio"/>
      <boot order="2"/>
      <address type="pci" domain="0x0000" bus="0x04" slot="0x00" function="0x0"/>
    </disk>
    <controller type="usb" index="0" model="qemu-xhci" ports="15">
      <address type="pci" domain="0x0000" bus="0x02" slot="0x00" function="0x0"/>
    </controller>
    <controller type="pci" index="0" model="pcie-root"/>
    <controller type="pci" index="1" model="pcie-root-port">
      <model name="pcie-root-port"/>
      <target chassis="1" port="0x10"/>
      <address type="pci" domain="0x0000" bus="0x00" slot="0x02" function="0x0" multifunction="on"/>
    </controller>
    <controller type="pci" index="2" model="pcie-root-port">
      <model name="pcie-root-port"/>
      <target chassis="2" port="0x11"/>
      <address type="pci" domain="0x0000" bus="0x00" slot="0x02" function="0x1"/>
    </controller>
    <controller type="pci" index="3" model="pcie-root-port">
      <model name="pcie-root-port"/>
      <target chassis="3" port="0x12"/>
      <address type="pci" domain="0x0000" bus="0x00" slot="0x02" function="0x2"/>
    </controller>
    <controller type="pci" index="4" model="pcie-root-port">
      <model name="pcie-root-port"/>
      <target chassis="4" port="0x13"/>
      <address type="pci" domain="0x0000" bus="0x00" slot="0x02" function="0x3"/>
    </controller>
    <controller type="pci" index="5" model="pcie-root-port">
      <model name="pcie-root-port"/>
      <target chassis="5" port="0x14"/>
      <address type="pci" domain="0x0000" bus="0x00" slot="0x02" function="0x4"/>
    </controller>
    <controller type="pci" index="6" model="pcie-root-port">
      <model name="pcie-root-port"/>
      <target chassis="6" port="0x15"/>
      <address type="pci" domain="0x0000" bus="0x00" slot="0x02" function="0x5"/>
    </controller>
    <controller type="pci" index="7" model="pcie-root-port">
      <model name="pcie-root-port"/>
      <target chassis="7" port="0x16"/>
      <address type="pci" domain="0x0000" bus="0x00" slot="0x02" function="0x6"/>
    </controller>
    <controller type="pci" index="8" model="pcie-root-port">
      <model name="pcie-root-port"/>
      <target chassis="8" port="0x17"/>
      <address type="pci" domain="0x0000" bus="0x00" slot="0x02" function="0x7"/>
    </controller>
    <controller type="pci" index="9" model="pcie-root-port">
      <model name="pcie-root-port"/>
      <target chassis="9" port="0x18"/>
      <address type="pci" domain="0x0000" bus="0x00" slot="0x03" function="0x0" multifunction="on"/>
    </controller>
    <controller type="pci" index="10" model="pcie-root-port">
      <model name="pcie-root-port"/>
      <target chassis="10" port="0x19"/>
      <address type="pci" domain="0x0000" bus="0x00" slot="0x03" function="0x1"/>
    </controller>
    <controller type="pci" index="11" model="pcie-root-port">
      <model name="pcie-root-port"/>
      <target chassis="11" port="0x1a"/>
      <address type="pci" domain="0x0000" bus="0x00" slot="0x03" function="0x2"/>
    </controller>
    <controller type="pci" index="12" model="pcie-root-port">
      <model name="pcie-root-port"/>
      <target chassis="12" port="0x1b"/>
      <address type="pci" domain="0x0000" bus="0x00" slot="0x03" function="0x3"/>
    </controller>
    <controller type="pci" index="13" model="pcie-root-port">
      <model name="pcie-root-port"/>
      <target chassis="13" port="0x1c"/>
      <address type="pci" domain="0x0000" bus="0x00" slot="0x03" function="0x4"/>
    </controller>
    <controller type="pci" index="14" model="pcie-root-port">
      <model name="pcie-root-port"/>
      <target chassis="14" port="0x1d"/>
      <address type="pci" domain="0x0000" bus="0x00" slot="0x03" function="0x5"/>
    </controller>
    <controller type="sata" index="0">
      <address type="pci" domain="0x0000" bus="0x00" slot="0x1f" function="0x2"/>
    </controller>
    <controller type="virtio-serial" index="0">
      <address type="pci" domain="0x0000" bus="0x03" slot="0x00" function="0x0"/>
    </controller>
    <interface type="direct" trustGuestRxFilters="yes">
      <mac address="52:54:00:d3:4f:fd"/>
      <source dev="eth0" mode="bridge"/>
      <model type="virtio"/>
      <address type="pci" domain="0x0000" bus="0x01" slot="0x00" function="0x0"/>
    </interface>
    <serial type="pty">
      <target type="isa-serial" port="0">
        <model name="isa-serial"/>
      </target>
    </serial>
    <console type="pty">
      <target type="serial" port="0"/>
    </console>
    <channel type="spicevmc">
      <target type="virtio" name="com.redhat.spice.0"/>
      <address type="virtio-serial" controller="0" bus="0" port="1"/>
    </channel>
    <input type="mouse" bus="ps2"/>
    <input type="keyboard" bus="ps2"/>
    <input type="tablet" bus="virtio">
      <address type="pci" domain="0x0000" bus="0x06" slot="0x00" function="0x0"/>
    </input>
    <input type="keyboard" bus="virtio">
      <address type="pci" domain="0x0000" bus="0x07" slot="0x00" function="0x0"/>
    </input>
    <graphics type="spice" autoport="yes">
      <listen type="address"/>
    </graphics>
    <sound model="ich9">
      <address type="pci" domain="0x0000" bus="0x00" slot="0x1b" function="0x0"/>
    </sound>
    <audio id="1" type="spice"/>
    <video>
      <model type="qxl" ram="65536" vram="65536" vgamem="16384" heads="1" primary="yes"/>
      <address type="pci" domain="0x0000" bus="0x00" slot="0x01" function="0x0"/>
    </video>
    <redirdev bus="usb" type="spicevmc">
      <address type="usb" bus="0" port="2"/>
    </redirdev>
    <redirdev bus="usb" type="spicevmc">
      <address type="usb" bus="0" port="3"/>
    </redirdev>
    <memballoon model="virtio">
      <address type="pci" domain="0x0000" bus="0x05" slot="0x00" function="0x0"/>
    </memballoon>
  </devices>
</domain>
```