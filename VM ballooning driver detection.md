# Hypervisor detection

```bash
dmidecode -s system-product-name
```

or

```bash
lsmod | grep "vbox\|hv\|xen\|vmxnet\|vmhgfs\|vmmemctl\|vmware_balloon"
```

## VM ballooning

```bash
cat /proc/hyperv/balloon /proc/virtio/balloon /proc/vmware/balloon /proc/xen/balloon
```

## VMWare examples

```bash
vmware-toolbox-cmd stat balloon
cat /proc/vmmemctl /proc/vmware/balloon
```

## Xen example

```bash
$ cat /proc/xen/balloon

Current allocation: 114688 kB
Requested target: 114688 kB
Low-mem balloon: 24576 kB
High-mem balloon: 0 kB
Driver pages: 136 kB
Xen hard limit: ??? kB
```
