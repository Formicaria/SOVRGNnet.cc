import { describe, expect, it } from "vitest";
import { lanAddresses, shareableHost } from "./lanHost";
import type { networkInterfaces } from "node:os";

/**
 * The invite-origin bug, kept dead.
 *
 * A hosted desktop server's owner browses it at 127.0.0.1, and for two
 * releases every invite they shared carried that host — a link to the
 * recipient's own machine. The claim "friends on your network can join with
 * an invite link" shipped unwalked. These tests pin the substitution that
 * makes it true, and just as deliberately pin where it must NOT fire.
 */

type Reader = typeof networkInterfaces;

function reader(map: Record<string, Array<{ address: string; family?: string | number; internal?: boolean }>>): Reader {
  return (() =>
    Object.fromEntries(
      Object.entries(map).map(([name, entries]) => [
        name,
        entries.map(entry => ({
          address: entry.address,
          family: entry.family ?? "IPv4",
          internal: entry.internal ?? false,
          netmask: "255.255.255.0",
          mac: "00:00:00:00:00:00",
          cidr: null,
        })),
      ])
    )) as unknown as Reader;
}

const HOME_LAN = reader({
  lo: [{ address: "127.0.0.1", internal: true }],
  wlan0: [{ address: "192.168.1.50" }],
});

describe("shareableHost substitutes loopback, and only loopback", () => {
  it("replaces 127.0.0.1 with the LAN address, keeping the port", () => {
    expect(shareableHost("127.0.0.1:3100", HOME_LAN)).toBe("192.168.1.50:3100");
  });

  it("replaces localhost and ::1 spellings too", () => {
    expect(shareableHost("localhost:3100", HOME_LAN)).toBe("192.168.1.50:3100");
    expect(shareableHost("[::1]:3100", HOME_LAN)).toBe("192.168.1.50:3100");
  });

  it("handles a portless host", () => {
    expect(shareableHost("localhost", HOME_LAN)).toBe("192.168.1.50");
  });

  it("passes a public hostname through untouched", () => {
    // Behind the tunnel, the forwarded host is the one truth. Substituting
    // there would break the deployment that already worked.
    expect(shareableHost("app.sovrgnnet.cc", HOME_LAN)).toBe("app.sovrgnnet.cc");
  });

  it("passes a LAN address through untouched", () => {
    // Someone browsing http://192.168.1.50:3000 shares the address they used.
    expect(shareableHost("192.168.1.50:3000", HOME_LAN)).toBe("192.168.1.50:3000");
  });

  it("does not mistake a bare IPv6 host for host:port", () => {
    expect(shareableHost("2001:db8::5", HOME_LAN)).toBe("2001:db8::5");
  });
});

describe("what gets offered as the LAN address", () => {
  it("prefers 192.168/16 over 10/8 over 172.16-31", () => {
    const mixed = reader({
      a: [{ address: "172.20.0.9" }],
      b: [{ address: "10.0.0.7" }],
      c: [{ address: "192.168.9.9" }],
    });
    expect(lanAddresses(mixed)).toEqual(["192.168.9.9", "10.0.0.7", "172.20.0.9"]);
  });

  it("ignores internal and non-IPv4 entries", () => {
    const noisy = reader({
      lo: [{ address: "127.0.0.1", internal: true }],
      wlan0: [
        { address: "fe80::1", family: "IPv6" },
        { address: "192.168.4.4" },
      ],
    });
    expect(lanAddresses(noisy)).toEqual(["192.168.4.4"]);
  });

  it("accepts Node's numeric family spelling", () => {
    const numeric = reader({ eth0: [{ address: "10.1.1.1", family: 4 }] });
    expect(lanAddresses(numeric)).toEqual(["10.1.1.1"]);
  });
});

describe("where substitution refuses to guess", () => {
  it("keeps loopback when there is nothing better", () => {
    // Airplane mode. An honest dead link beats an invented one.
    const only_lo = reader({ lo: [{ address: "127.0.0.1", internal: true }] });
    expect(shareableHost("127.0.0.1:3100", only_lo)).toBe("127.0.0.1:3100");
  });

  it("refuses the default Docker bridge", () => {
    // Inside a container these are the container's interfaces; 172.17/16 is
    // docker0. Handing it out swaps an obviously-wrong link for a plausibly
    // wrong one, and only the first kind gets fixed rather than debugged.
    const docker = reader({ eth0: [{ address: "172.17.0.3" }] });
    expect(shareableHost("localhost:3000", docker)).toBe("localhost:3000");
  });

  it("still uses a real 172.16-31 LAN when it isn't the docker default", () => {
    const rare_lan = reader({ eth0: [{ address: "172.22.8.14" }] });
    expect(shareableHost("localhost:3000", rare_lan)).toBe("172.22.8.14:3000");
  });
});
