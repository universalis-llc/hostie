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
  <qemu:commandline>
    <qemu:arg value="-device"/>
    <qemu:arg value="vfio-pci,sysfsdev=/sys/bus/mdev/devices/4b20d080-1b54-4048-85b3-a6a62d165c02,display=off,id=hostpci0.0,addr=0x6.0,x-pci-vendor-id=0x10de,x-pci-device-id=0x17F0,x-pci-sub-vendor-id=0x10de,x-pci-sub-device-id=0x11A0"/>
    <qemu:arg value="-uuid"/>
    <qemu:arg value="4b20d080-1b54-4048-85b3-a6a62d165c02"/>
  </qemu:commandline>
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