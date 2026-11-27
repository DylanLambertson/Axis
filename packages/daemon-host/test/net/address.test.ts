// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { test } from "node:test";
import { addressRefusal, embeddedIpv4, IPV4_RESERVED, parseIpv4, parseIpv6, resolvedRefusal } from "../../src/net/address.js";

// PV-N1d slice A: the public-unicast rule of ADR 0009 decision 4, range by range, written out here independently of the
// module so a changed range fails, with every range's edges and the addresses just outside them.

const V4: ReadonlyArray<readonly [string, number]> = [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
  ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
];
const toText = (n: number): string => [24, 16, 8, 0].map((s) => Math.floor(n / 2 ** s) % 256).join(".");
const inAny = (n: number): boolean => V4.some(([net, len]) => Math.floor(n / 2 ** (32 - len)) === Math.floor(parseIpv4(net)! / 2 ** (32 - len)));

test("IPv4: the list is the ADR's, and every range's first and last address are refused, the neighbours outside it are not", () => {
  assert.deepEqual(IPV4_RESERVED, V4);
  for (const [net, len] of V4) {
    const first = parseIpv4(net)!;
    const last = first + 2 ** (32 - len) - 1;
    for (const n of [first, last, first + 1, last - 1]) assert.equal(addressRefusal(toText(n)), "ipv4_reserved", `${toText(n)} in ${net}/${len}`);
    for (const n of [first - 1, last + 1]) {
      if (n < 0 || n > 0xffffffff) continue;
      assert.equal(addressRefusal(toText(n)), inAny(n) ? "ipv4_reserved" : null, `${toText(n)} next to ${net}/${len}`);
    }
  }
  for (const ok of ["1.1.1.1", "8.8.8.8", "100.63.255.255", "100.128.0.0", "172.15.255.255", "172.32.0.0", "223.255.255.255", "198.17.255.255", "198.20.0.0"]) {
    assert.equal(addressRefusal(ok), null, ok);
  }
});

test("IPv4 spelling: only strict dotted decimal is an address; anything else is malformed, never guessed", () => {
  for (const bad of ["127.1", "0x7f.0.0.1", "0177.0.0.1", "2130706433", "01.2.3.4", "1.2.3.256", "1.2.3", "1.2.3.4.5", " 1.2.3.4", "1.2.3.4 ", "", "a.b.c.d", "1.2.3.-4"]) {
    assert.equal(addressRefusal(bad), "malformed", JSON.stringify(bad));
  }
  assert.equal(parseIpv4("255.255.255.255"), 0xffffffff);
  assert.equal(parseIpv4("0.0.0.0"), 0);
});

test("IPv6: only 2000::/3 is global; its reserved blocks are refused at their edges; the rest is public", () => {
  for (const out of ["::", "::1", "fe80::1", "fc00::1", "fd12::1", "fec0::1", "ff02::1", "100::1", "1fff:ffff::1", "4000::1", "e000::1"]) {
    assert.ok(["ipv6_not_global", "embedded_ipv4_reserved"].includes(addressRefusal(out) as string), `${out}: ${addressRefusal(out)}`);
  }
  for (const [a, why] of [
    ["2001:1::1", "2001::/23"], ["2001:100::1", "2001::/23, ORCHID side"], ["2001:1ff:ffff::1", "2001::/23 end"], ["2001:db8::1", "documentation"], ["2001:db8:ffff::1", "documentation end"],
    ["3fff::1", "3fff::/20"], ["3fff:fff:ffff::1", "3fff::/20 end"], ["2002:808:808::1", "6to4 with a public embedded address"],
  ] as const) assert.equal(addressRefusal(a), "ipv6_reserved", why);
  for (const ok of ["2001:200::1", "2001:db7:ffff::1", "2001:db9::1", "2001:4860:4860::8888", "2606:4700::1111", "3ffe:ffff::1", "3fff:1000::1", "2003::1", "2000::1", "3fff:ffff:ffff:ffff:ffff:ffff:ffff:ffff"]) {
    assert.equal(addressRefusal(ok), null, ok);
  }
});

test("embedded IPv4 is checked first, in every form, and a reserved one is refused with its own reason", () => {
  const reserved: ReadonlyArray<readonly [string, string]> = [
    ["::ffff:127.0.0.1", "mapped"], ["::ffff:7f00:1", "mapped, hex"], ["::ffff:169.254.169.254", "mapped metadata"],
    ["::127.0.0.1", "compatible"], ["::a00:1", "compatible, hex"], ["::ffff:0:10.0.0.1", "SIIT"], ["::ffff:0:a00:1", "SIIT, hex"],
    ["64:ff9b::127.0.0.1", "NAT64"], ["64:ff9b::c0a8:101", "NAT64, hex 192.168.1.1"], ["64:ff9b:1::10.1.2.3", "local-use NAT64"],
    ["64:ff9b:1:ffff::a9fe:a9fe", "local-use NAT64, metadata"], ["2002:7f00:1::", "6to4 of 127.0.0.1"], ["2002:c0a8:101::1", "6to4 of 192.168.1.1"],
    ["2001::1", "Teredo server 0.0.0.0"], ["2001:0:a00:1::1", "Teredo server 10.0.0.1"], ["2001:0:808:808::80ff:fffe", "Teredo client 127.0.0.1"],
  ];
  for (const [a, form] of reserved) assert.equal(addressRefusal(a), "embedded_ipv4_reserved", form);
  // A public embedded address is still refused by the outer rule, with the outer reason.
  assert.equal(addressRefusal("::ffff:8.8.8.8"), "ipv6_not_global");
  assert.equal(addressRefusal("64:ff9b::808:808"), "ipv6_not_global");
  assert.equal(addressRefusal("2001:0:808:808::f7f7:f7f7"), "ipv6_reserved");
  assert.deepEqual(embeddedIpv4(parseIpv6("2001:0:a00:1::80ff:fffe")!), [parseIpv4("10.0.0.1"), parseIpv4("127.0.0.1")]);
  assert.deepEqual(embeddedIpv4(parseIpv6("2606:4700::1111")!), []);
});

test("IPv6 spelling: zone ids, bad compression and bad words are malformed", () => {
  for (const bad of ["fe80::1%eth0", "2001:db8::1%1", "1::2::3", "1:2:3:4:5:6:7::8::9", "1:2:3:4:5:6:7:8::9::a", "1:2:3:4::5:6:7:8", "1:2:3:4:5:6:7:8:9", "1:2:3:4:5:6:7", "12345::1", "g::1", ":::", "2001:4860::1.2.3", "::ffff:1.2.3.256", "1:2:3:4:5:6:7:1.2.3.4"]) {
    assert.equal(addressRefusal(bad), "malformed", bad);
  }
  assert.deepEqual(parseIpv6("1:2:3:4:5:6:7:8"), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(parseIpv6("1:2:3:4:5:6:1.2.3.4"), [1, 2, 3, 4, 5, 6, 0x102, 0x304]);
  assert.deepEqual(parseIpv6("1::8"), [1, 0, 0, 0, 0, 0, 0, 8]);
  assert.deepEqual(parseIpv6("::"), [0, 0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(parseIpv6("2001:DB8::A"), [0x2001, 0xdb8, 0, 0, 0, 0, 0, 0xa]);
});

test("everything a lookup returned must be public: one bad address refuses, none returned refuses", () => {
  assert.equal(resolvedRefusal(["1.1.1.1", "2606:4700::1111"]), null);
  assert.equal(resolvedRefusal(["1.1.1.1", "10.0.0.1"]), "ipv4_reserved");
  assert.equal(resolvedRefusal(["2606:4700::1111", "::ffff:127.0.0.1"]), "embedded_ipv4_reserved");
  assert.equal(resolvedRefusal(["1.1.1.1", "nonsense"]), "malformed");
  assert.equal(resolvedRefusal([]), "no_address");
});
