// Every external artefact the VM installs, pinned to an exact version AND a
// checksum. The box downloads them at first boot and refuses to continue on a
// mismatch: a moved tag or a tampered mirror stops the boot, it never runs.
//
// To move a pin: read the new release's published checksum(s), bump them here,
// run `npm test`, then deploy (a pin change rewrites the user data, which
// REPLACES the instance — see README "Upgrades"). The deploy first copies each
// artefact into the stack's own S3 mirror (lib/mirror.ts, README "Binary
// mirror") after checking the same checksum, so the new box never depends on a
// third-party site being up.

/** Forgejo 17.0.1 (2026-10-26): latest stable on 2026-11-17, carries the 26/10 security fixes. */
export const FORGEJO = {
  version: "17.0.1",
  // code.forgejo.org: the Forgejo project's own instance (same release, same bytes). codeberg.org stopped
  // resolving on 2026-11-18 and a boot that cannot fetch the binary never serves.
  url: "https://code.forgejo.org/forgejo/forgejo/releases/download/v17.0.1/forgejo-17.0.1-linux-arm64.xz",
  // sha256 of the DECOMPRESSED binary (forgejo-17.0.1-linux-arm64.sha256).
  sha256: "1e99403746406e8199efc903ddd1940d5728a60e50241f7aa6c9f2b907bd8ec9",
  // sha256 of the .xz itself (forgejo-17.0.1-linux-arm64.xz.sha256): what the deploy-time mirror checks
  // before writing to S3 (it does not decompress). The box still checks `sha256` above.
  xzSha256: "f615b9d8d24e685f30d96a21c1c34900a2016961bbf37b5e883e0354a3d535d6",
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
