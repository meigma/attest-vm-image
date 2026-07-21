#!/usr/bin/env bash
#
# make-test-image.sh — build a tiny but OS-inspectable QCOW2 for the integration
# workflow. The attest-vm-image pipeline fails closed on an image it cannot
# inspect, so a bare mkfs filesystem is not enough: this seeds a minimal
# Debian/Ubuntu-style ext4 root with /etc/os-release, the usual top-level
# directories, and a small real dpkg database that both libguestfs
# list-applications2 and syft's dpkg cataloger parse. At least one seeded package
# (openssl 3.0.2-0ubuntu1) has known HIGH/CRITICAL CVEs in the Ubuntu 22.04 grype
# feed, which feeds the threshold-breach job.
#
# Usage: make-test-image.sh <output-qcow2-path>

set -euo pipefail

out="${1:?usage: make-test-image.sh <output-qcow2-path>}"

qemu-img create -f qcow2 "$out" 512M

# Stage a minimal but valid x86_64 ELF64 header (64 bytes) to seed as
# /sbin/init. An empty `touch` file leaves inspect-get-arch returning "unknown",
# which ships an unresolved operatingSystem.arch in the predicate; a real ELF
# header lets libguestfs resolve the architecture to x86_64. The path is a fixed
# literal so it can be referenced from the quoted guestfish heredoc below
# without needing shell interpolation.
init_elf="/tmp/attest-seed-init.elf"
printf '\177ELF\002\001\001\000\000\000\000\000\000\000\000\000\002\000\076\000\001\000\000\000\000\000\000\000\000\000\000\000\000\000\000\000\000\000\000\000\000\000\000\000\000\000\000\000\000\000\000\000\100\000\000\000\000\000\000\000\000\000\000\000' >"$init_elf"

guestfish --rw -a "$out" <<'EOF'
run
mkfs ext4 /dev/sda
mount /dev/sda /
mkdir-p /etc
mkdir-p /bin
mkdir-p /sbin
mkdir-p /usr/bin
mkdir-p /var/lib/dpkg
mkdir-p /root
mkdir-p /home
mkdir-p /tmp
mkdir-p /run
write /etc/os-release "PRETTY_NAME=\"Ubuntu 22.04.4 LTS\"\nNAME=\"Ubuntu\"\nVERSION_ID=\"22.04\"\nVERSION=\"22.04.4 LTS (Jammy Jellyfish)\"\nVERSION_CODENAME=jammy\nID=ubuntu\nID_LIKE=debian\nUBUNTU_CODENAME=jammy\n"
write /etc/fstab "LABEL=cloudimg-rootfs / ext4 defaults 0 1\n"
upload /tmp/attest-seed-init.elf /sbin/init
write /var/lib/dpkg/status "Package: base-files\nStatus: install ok installed\nPriority: required\nSection: admin\nInstalled-Size: 393\nMaintainer: Ubuntu Developers <ubuntu-devel-discuss@lists.ubuntu.com>\nArchitecture: amd64\nVersion: 12ubuntu4\nDescription: Debian base system miscellaneous files\n This package contains the basic filesystem hierarchy of a Debian system.\n\nPackage: openssl\nStatus: install ok installed\nPriority: optional\nSection: utils\nInstalled-Size: 1276\nMaintainer: Ubuntu Developers <ubuntu-devel-discuss@lists.ubuntu.com>\nArchitecture: amd64\nVersion: 3.0.2-0ubuntu1\nDepends: libc6 (>= 2.34), libssl3 (>= 3.0.2)\nDescription: Secure Sockets Layer toolkit - cryptographic utility\n This package is part of the OpenSSL project's implementation of the SSL\n and TLS cryptographic protocols for secure communication over the Internet.\n\nPackage: zlib1g\nStatus: install ok installed\nPriority: required\nSection: libs\nInstalled-Size: 163\nMaintainer: Ubuntu Developers <ubuntu-devel-discuss@lists.ubuntu.com>\nArchitecture: amd64\nMulti-Arch: same\nSource: zlib\nVersion: 1:1.2.11.dfsg-2ubuntu9\nDepends: libc6 (>= 2.14)\nDescription: compression library - runtime\n zlib is a library implementing the deflate compression method found in gzip\n and PKZIP.\n\n"
umount /
EOF

rm -f "$init_elf"

echo "Wrote seeded QCOW2 to $out"
