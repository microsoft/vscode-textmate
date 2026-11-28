#!/usr/bin/env bash
#---------------------------------------------------------
# Copyright (C) Microsoft Corporation. All rights reserved.
#---------------------------------------------------------

# Generates vendor/onig_sys from the onig_sys crate on crates.io and the
# patches in vendor/patches. With --check, generates it in a temporary folder
# and fails if vendor/onig_sys differs. See vendor/README.md.

set -euo pipefail

VERSION=69.8.1
SHA256=7b829e3d7e9cc74c7e315ee8edb185bf4190da5acde74afd7fc59c35b1f086e7

# The files of oniguruma/src that build.rs neither compiles nor includes.
EXCLUDED=' Makefile.am Makefile.windows config.h.cmake.in config.h.windows.in euc_jp_prop.gperf sjis_prop.gperf gperf_fold_key_conv.py gperf_unfold_key_conv.py koi8.c mktable.c make_property.sh make_unicode_egcb.sh make_unicode_egcb_data.py make_unicode_fold.sh make_unicode_fold_data.py make_unicode_property.sh make_unicode_property_data.py make_unicode_wb.sh make_unicode_wb_data.py '

usage() {
	echo "usage: $0 [--check]" >&2
	exit 2
}

check=0
if [ $# -gt 1 ]; then
	usage
fi
case "${1:-}" in
	'') ;;
	--check) check=1 ;;
	*) usage ;;
esac

vendor=$(cd "$(dirname "$0")" && pwd)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

crate=
for f in "${CARGO_HOME:-$HOME/.cargo}"/registry/cache/*/"onig_sys-$VERSION.crate"; do
	if [ -f "$f" ]; then
		crate=$f
		break
	fi
done
if [ -z "$crate" ]; then
	crate=$tmp/onig_sys-$VERSION.crate
	curl -fsSL -o "$crate" "https://static.crates.io/crates/onig_sys/onig_sys-$VERSION.crate"
fi

if command -v shasum > /dev/null; then
	actual=$(shasum -a 256 "$crate" | cut -d ' ' -f 1)
else
	actual=$(sha256sum "$crate" | cut -d ' ' -f 1)
fi
if [ "$actual" != "$SHA256" ]; then
	echo "$crate has SHA-256 $actual, not $SHA256" >&2
	exit 1
fi

tar -xzf "$crate" -C "$tmp"
src=$tmp/onig_sys-$VERSION
tree=$tmp/onig_sys
mkdir -p "$tree/src" "$tree/oniguruma/src"
for f in Cargo.toml LICENSE.md build.rs oniguruma/COPYING src/bindgened.rs src/ffi.rs src/lib.rs; do
	cp "$src/$f" "$tree/$f"
done
for f in "$src"/oniguruma/src/*; do
	name=$(basename "$f")
	case "$EXCLUDED" in
		*" $name "*) ;;
		*) cp "$f" "$tree/oniguruma/src/$name" ;;
	esac
done
find "$tree" -type f -exec chmod 644 {} +

# A repository of its own, so that git apply takes the paths of the patches
# from the root of the crate wherever the temporary folder is.
git -C "$tree" -c init.defaultBranch=main init -q
for patch in "$vendor"/patches/*.patch; do
	if ! git -C "$tree" apply --whitespace=nowarn "$patch"; then
		echo "patches/$(basename "$patch") does not apply to onig_sys $VERSION; see vendor/README.md" >&2
		exit 1
	fi
done
rm -rf "$tree/.git"

if [ $check -eq 1 ]; then
	if ! (cd "$tmp" && diff -ru onig_sys "$vendor/onig_sys"); then
		echo "vendor/onig_sys differs from onig_sys $VERSION with the patches in vendor/patches" >&2
		exit 1
	fi
	echo "vendor/onig_sys is onig_sys $VERSION with the patches in vendor/patches"
else
	rm -rf "$vendor/onig_sys"
	cp -R "$tree" "$vendor/onig_sys"
	echo "generated vendor/onig_sys from onig_sys $VERSION and the patches in vendor/patches"
fi
