// Every external artefact the VM installs, pinned to an exact version AND a
// checksum. The box downloads them at first boot and refuses to continue on a
// mismatch: a moved tag or a tampered mirror stops the boot, it never runs.
//
// To move a pin: read the new release's published checksum, bump the pair
// here, run `npm test`, then deploy (a pin change rewrites the user data, which
// REPLACES the instance — see README "Upgrades").

/** Forgejo 17.0.1 (2026-10-26): latest stable on 2026-11-17, carries the 26/10 security fixes. */
export const FORGEJO = {
  version: "17.0.1",
  url: "https://codeberg.org/forgejo/forgejo/releases/download/v17.0.1/forgejo-17.0.1-linux-arm64.xz",
  // sha256 of the DECOMPRESSED binary (forgejo-17.0.1-linux-arm64.sha256).
  sha256: "1e99403746406e8199efc903ddd1940d5728a60e50241f7aa6c9f2b907bd8ec9",
} as const;

/** Caddy 2.11.9 (2026-11-05): TLS + the request body cap in front of Forgejo. */
export const CADDY = {
  version: "2.11.9",
  url: "https://github.com/caddyserver/caddy/releases/download/v2.11.9/caddy_2.11.9_linux_arm64.tar.gz",
  // sha512 of the tarball (caddy_2.11.9_checksums.txt).
  sha512:
    "9e5e76d7888542924de2c25353ae87c5f77e2a22c5b1198633cae13688922282e05383d142599205c88d8d80eee5e967d291214d7abce4835329a191b20dd6e0",
} as const;

/**
 * AL2023 arm64, kernel 6.1 — `al2023-ami-2023.12.20261112.0-kernel-6.1-arm64`
 * (owner amazon), read on 2026-11-17. A literal id, never a "latest" lookup:
 * the lookup re-resolves at every deploy and would replace the VM the first
 * time anything is deployed after AWS publishes an image (same reasoning as
 * dilaya/aws-sqlite-data's ami-pin.ts). `amiId` overrides it.
 */
export const PINNED_AMI_IDS: Readonly<Record<string, string>> = {
  "eu-west-1": "ami-0858af688118a556e",
};
