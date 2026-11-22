// Copyright (c) 2026 Dylan Lambertson. All rights reserved.

/*
 * The egress client's address rule (ticket PV-N1d slice A; ADR 0009 decision 4, TB24): a resolved address is used only
 * when it is public unicast. Pure functions over the textual address `lookup` returns; nothing here opens a socket.
 *
 * - IPv4 public unicast excludes 0/8, 10/8, 100.64/10, 127/8, 169.254/16, 172.16/12, 192.0.0/24, 192.0.2/24,
 *   192.88.99/24, 192.168/16, 198.18/15, 198.51.100/24, 203.0.113/24, 224/4 and 240/4.
 * - IPv6 public unicast is inside 2000::/3, minus 2001::/23 (Teredo, benchmarking, ORCHID included), 2001:db8::/32,
 *   3fff::/20 and 2002::/16.
 * - An IPv4 address embedded in an IPv6 one (IPv4-mapped, IPv4-compatible, SIIT, the NAT64 prefixes 64:ff9b::/96 and
 *   64:ff9b:1::/48, 6to4 2002::/16, Teredo's server and client) is checked against the IPv4 list FIRST, so a reserved
 *   embedded address is refused with its own reason whatever the outer rule would say.
 * - A zone id (`fe80::1%eth0`), a non-canonical IPv4 spelling or anything that is not an address is malformed.
 */

export type AddressRefusal = "malformed" | "ipv4_reserved" | "ipv6_not_global" | "ipv6_reserved" | "embedded_ipv4_reserved";

/** IPv4 ranges that are not public unicast, as [network, prefix length]. */
export const IPV4_RESERVED: ReadonlyArray<readonly [string, number]> = [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
  ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
];

/** Strict dotted decimal: four parts 0 to 255, no leading zero, nothing else. The address as an unsigned 32-bit number. */
export function parseIpv4(text: string): number | undefined {
  const parts = text.split(".");
  if (parts.length !== 4) return undefined;
  let value = 0;
  for (const p of parts) {
    if (!/^(?:0|[1-9][0-9]{0,2})$/.test(p)) return undefined;
    const n = Number(p);
    if (n > 255) return undefined;
    value = value * 256 + n;
  }
  return value;
}

const RESERVED_V4: ReadonlyArray<readonly [number, number]> = IPV4_RESERVED.map(([net, len]) => [parseIpv4(net) as number, len] as const);

function v4Reserved(value: number): boolean {
  return RESERVED_V4.some(([net, len]) => Math.floor(value / 2 ** (32 - len)) === Math.floor(net / 2 ** (32 - len)));
}

/**
 * Eight 16-bit words, or undefined: `::` compression, a trailing dotted IPv4, hex words of 1 to 4 digits. A zone id
 * (`%eth0`) is never a hex word or part of a dotted IPv4, so it is refused by those rules.
 */
export function parseIpv6(text: string): number[] | undefined {
  let tail: number[] = [];
  let body = text;
  const lastColon = text.lastIndexOf(":");
  if (lastColon >= 0 && text.slice(lastColon + 1).includes(".")) {
    const v4 = parseIpv4(text.slice(lastColon + 1));
    if (v4 === undefined) return undefined;
    tail = [Math.floor(v4 / 65536), v4 % 65536];
    body = text.slice(0, lastColon + 1) + "0"; // a placeholder word, dropped below
  }
  const halves = body.split("::");
  if (halves.length > 2) return undefined;
  const words = (s: string): number[] | undefined => {
    if (s === "") return [];
    const out: number[] = [];
    for (const w of s.split(":")) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(w)) return undefined;
      out.push(parseInt(w, 16));
    }
    return out;
  };
  const head = words(halves[0] as string);
  const rest = halves.length === 2 ? words(halves[1] as string) : [];
  if (head === undefined || rest === undefined) return undefined;
  if (tail.length > 0) (rest.length > 0 ? rest : head).pop();
  const given = head.length + rest.length + tail.length;
  if (halves.length === 2 ? given > 7 : given !== 8) return undefined;
  return [...head, ...new Array<number>(8 - given).fill(0), ...rest, ...tail];
}

const v4Of = (hi: number, lo: number): number => hi * 65536 + lo;

/** The IPv4 addresses an IPv6 address carries (mapped, compatible, SIIT, NAT64, 6to4, Teredo), or none. */
export function embeddedIpv4(w: readonly number[]): number[] {
  const zero = (from: number, to: number): boolean => w.slice(from, to).every((x) => x === 0);
  const out: number[] = [];
  if (zero(0, 5) && w[5] === 0xffff) out.push(v4Of(w[6]!, w[7]!)); // ::ffff:0:0/96, IPv4-mapped
  if (zero(0, 6)) out.push(v4Of(w[6]!, w[7]!)); // ::/96, IPv4-compatible (:: and ::1 included)
  if (zero(0, 4) && w[4] === 0xffff && w[5] === 0) out.push(v4Of(w[6]!, w[7]!)); // ::ffff:0:0:0/96, SIIT
  if (w[0] === 0x64 && w[1] === 0xff9b && zero(2, 6)) out.push(v4Of(w[6]!, w[7]!)); // 64:ff9b::/96, NAT64
  if (w[0] === 0x64 && w[1] === 0xff9b && w[2] === 1) out.push(v4Of(w[6]!, w[7]!)); // 64:ff9b:1::/48, local-use NAT64
  if (w[0] === 0x2002) out.push(v4Of(w[1]!, w[2]!)); // 2002::/16, 6to4
  if (w[0] === 0x2001 && w[1] === 0) out.push(v4Of(w[2]!, w[3]!), v4Of(w[6]! ^ 0xffff, w[7]! ^ 0xffff)); // 2001::/32, Teredo server and client
  return out;
}

/** Why `address` may not be connected to, or null when it is public unicast. */
export function addressRefusal(address: string): AddressRefusal | null {
  if (address.includes(":")) {
    const w = parseIpv6(address);
    if (w === undefined) return "malformed";
    if (embeddedIpv4(w).some(v4Reserved)) return "embedded_ipv4_reserved";
    if ((w[0]! & 0xe000) !== 0x2000) return "ipv6_not_global"; // outside 2000::/3
    if (w[0] === 0x2001 && (w[1]! & 0xfe00) === 0) return "ipv6_reserved"; // 2001::/23
    if (w[0] === 0x2001 && w[1] === 0x0db8) return "ipv6_reserved"; // 2001:db8::/32
    if (w[0] === 0x3fff && (w[1]! & 0xf000) === 0) return "ipv6_reserved"; // 3fff::/20
    if (w[0] === 0x2002) return "ipv6_reserved"; // 2002::/16
    return null;
  }
  const v4 = parseIpv4(address);
  if (v4 === undefined) return "malformed";
  return v4Reserved(v4) ? "ipv4_reserved" : null;
}

/** The first refusal among everything a lookup returned (none returned is a refusal too), or null when every address is public. */
export function resolvedRefusal(addresses: readonly string[]): AddressRefusal | "no_address" | null {
  if (addresses.length === 0) return "no_address";
  for (const a of addresses) {
    const r = addressRefusal(a);
    if (r !== null) return r;
  }
  return null;
}
