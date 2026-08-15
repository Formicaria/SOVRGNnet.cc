import { describe, expect, it, vi } from "vitest";
import {
  ConnectionManager,
  NotASovrgnServer,
  ServerTooNew,
  memoryConnectionStore,
  normalizeHost,
  probeInstance,
  webConnectionStore,
  type Connection,
} from "@shared/connections";

function instancePayload(overrides: Record<string, unknown> = {}) {
  return {
    product: "sovrgnnet",
    apiVersion: 1,
    id: "abc123def4567890",
    name: "Zach's server",
    description: null,
    matrixServerName: "sovrgnnet.cc",
    matrixBaseUrl: null,
    joinPolicy: "invite",
    encryption: false,
    listed: false,
    software: { name: "sovrgnnet", version: "0.1.0" },
    ...overrides,
  };
}

/** A fetch stub that answers /api/instance for the hosts you name. */
function fakeFetch(byHost: Record<string, unknown | "fail">) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    const entry = byHost[url.host];
    if (entry === undefined || entry === "fail") {
      throw new Error("network");
    }
    return {
      ok: true,
      json: async () => entry,
    } as Response;
  }) as unknown as typeof fetch;
}

describe("normalizeHost", () => {
  it("assumes https for a bare domain", () => {
    expect(normalizeHost("chat.example.com")).toEqual({
      host: "chat.example.com",
      secure: true,
    });
  });

  it("keeps an explicit http scheme", () => {
    expect(normalizeHost("http://192.168.1.50:3000")).toEqual({
      host: "192.168.1.50:3000",
      secure: false,
    });
  });

  it("strips trailing slashes and paths", () => {
    expect(normalizeHost("https://chat.example.com/").host).toBe("chat.example.com");
  });

  it("rejects empty or nonsense input", () => {
    expect(() => normalizeHost("")).toThrow(/enter a server address/i);
    expect(() => normalizeHost("   ")).toThrow(/enter a server address/i);
  });
});

describe("probeInstance", () => {
  it("returns the payload for a real server", async () => {
    const info = await probeInstance(
      "https://chat.example.com",
      fakeFetch({ "chat.example.com": instancePayload() })
    );
    expect(info.name).toBe("Zach's server");
  });

  it("refuses a host that answers but isn't SOVRGNnet", async () => {
    await expect(
      probeInstance(
        "https://example.com",
        fakeFetch({ "example.com": { hello: "world" } })
      )
    ).rejects.toBeInstanceOf(NotASovrgnServer);
  });

  it("refuses a host that doesn't answer at all", async () => {
    await expect(
      probeInstance("https://nope.example.com", fakeFetch({}))
    ).rejects.toBeInstanceOf(NotASovrgnServer);
  });

  it("refuses a server speaking a newer protocol", async () => {
    // Better to say "update your client" than to guess at a payload shape.
    await expect(
      probeInstance(
        "https://chat.example.com",
        fakeFetch({ "chat.example.com": instancePayload({ apiVersion: 99 }) })
      )
    ).rejects.toBeInstanceOf(ServerTooNew);
  });
});

describe("ConnectionManager", () => {
  it("adds a server", async () => {
    const manager = new ConnectionManager(
      memoryConnectionStore(),
      fakeFetch({ "chat.example.com": instancePayload() })
    );
    const connection = await manager.connect("chat.example.com");

    expect(connection.name).toBe("Zach's server");
    expect(await manager.list()).toHaveLength(1);
  });

  it("treats the same server at a new address as one server", async () => {
    // The whole reason de-duplication is by instance id: a homelab box moves
    // from a LAN address to a domain, and it's still the same community.
    const store = memoryConnectionStore();
    const manager = new ConnectionManager(
      store,
      fakeFetch({
        "192.168.1.50:3000": instancePayload(),
        "chat.example.com": instancePayload(),
      })
    );

    await manager.connect("http://192.168.1.50:3000");
    await manager.connect("chat.example.com");

    const list = await manager.list();
    expect(list).toHaveLength(1);
    expect(list[0].host).toBe("chat.example.com");
  });

  it("keeps a server's position in the rail when re-added", async () => {
    const manager = new ConnectionManager(
      memoryConnectionStore(),
      fakeFetch({
        "a.example.com": instancePayload({ id: "aaaa000000000000", name: "A" }),
        "b.example.com": instancePayload({ id: "bbbb000000000000", name: "B" }),
      })
    );

    await manager.connect("a.example.com");
    await manager.connect("b.example.com");
    const before = (await manager.list()).map(c => c.id);

    await manager.connect("a.example.com");
    expect((await manager.list()).map(c => c.id)).toEqual(before);
  });

  it("adds distinct servers in the order they were added", async () => {
    const manager = new ConnectionManager(
      memoryConnectionStore(),
      fakeFetch({
        "a.example.com": instancePayload({ id: "aaaa000000000000", name: "A" }),
        "b.example.com": instancePayload({ id: "bbbb000000000000", name: "B" }),
      })
    );
    await manager.connect("a.example.com");
    await manager.connect("b.example.com");

    expect((await manager.list()).map(c => c.name)).toEqual(["A", "B"]);
  });

  it("doesn't record a server it couldn't reach", async () => {
    const store = memoryConnectionStore();
    const manager = new ConnectionManager(store, fakeFetch({}));

    await expect(manager.connect("nope.example.com")).rejects.toBeInstanceOf(
      NotASovrgnServer
    );
    expect(await store.read()).toEqual([]);
  });

  it("removes a server", async () => {
    const manager = new ConnectionManager(
      memoryConnectionStore(),
      fakeFetch({ "chat.example.com": instancePayload() })
    );
    const connection = await manager.connect("chat.example.com");
    await manager.disconnect(connection.id);

    expect(await manager.list()).toEqual([]);
  });

  it("reorders the rail", async () => {
    const manager = new ConnectionManager(
      memoryConnectionStore(),
      fakeFetch({
        "a.example.com": instancePayload({ id: "aaaa000000000000", name: "A" }),
        "b.example.com": instancePayload({ id: "bbbb000000000000", name: "B" }),
      })
    );
    await manager.connect("a.example.com");
    await manager.connect("b.example.com");

    const reordered = await manager.reorder(["bbbb000000000000", "aaaa000000000000"]);
    expect(reordered.map(c => c.name)).toEqual(["B", "A"]);
  });

  describe("connectFromInvite", () => {
    it("adds the server an invite points at", async () => {
      const manager = new ConnectionManager(
        memoryConnectionStore(),
        fakeFetch({ "chat.example.com": instancePayload() })
      );
      const { connection, parsed } = await manager.connectFromInvite(
        "https://chat.example.com/invite/abc123"
      );

      expect(connection.host).toBe("chat.example.com");
      expect(parsed.code).toBe("abc123");
    });

    it("works from a desktop deep link", async () => {
      const manager = new ConnectionManager(
        memoryConnectionStore(),
        fakeFetch({ "chat.example.com": instancePayload() })
      );
      const { parsed } = await manager.connectFromInvite(
        "sovrgn://invite/chat.example.com/abc123"
      );
      expect(parsed).toMatchObject({ host: "chat.example.com", code: "abc123" });
    });

    it("rejects something that isn't an invite", async () => {
      const manager = new ConnectionManager(memoryConnectionStore(), fakeFetch({}));
      await expect(manager.connectFromInvite("hello")).rejects.toThrow(/invite link/i);
    });
  });

  describe("refreshAll", () => {
    it("picks up a renamed server", async () => {
      const store = memoryConnectionStore();
      let payload = instancePayload({ name: "Old name" });
      const manager = new ConnectionManager(store, ((input: RequestInfo | URL) => {
        void input;
        return Promise.resolve({ ok: true, json: async () => payload } as Response);
      }) as unknown as typeof fetch);

      await manager.connect("chat.example.com");
      payload = instancePayload({ name: "New name" });
      const results = await manager.refreshAll();

      expect(results[0].reachable).toBe(true);
      expect((await manager.list())[0].name).toBe("New name");
    });

    it("keeps an unreachable server in the list", async () => {
      // A laptop shut for the night must not erase a community.
      const store = memoryConnectionStore([
        {
          id: "aaaa000000000000",
          host: "offline.example.com",
          secure: true,
          name: "Offline",
          matrixServerName: "offline.example.com",
          encryption: false,
          lastSeen: 0,
          order: 0,
        } satisfies Connection,
      ]);
      const manager = new ConnectionManager(store, fakeFetch({}));

      const results = await manager.refreshAll();
      expect(results[0].reachable).toBe(false);
      expect(await manager.list()).toHaveLength(1);
    });
  });
});

describe("webConnectionStore", () => {
  function fakeStorage() {
    const map = new Map<string, string>();
    return {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v),
    };
  }

  it("round-trips connections", async () => {
    const storage = fakeStorage();
    const store = webConnectionStore(storage);
    const connection: Connection = {
      id: "aaaa000000000000",
      host: "chat.example.com",
      secure: true,
      name: "Zach's server",
      matrixServerName: "sovrgnnet.cc",
      encryption: false,
      lastSeen: 123,
      order: 0,
    };

    await store.write([connection]);
    expect(await store.read()).toEqual([connection]);
  });

  it("starts empty rather than throwing on corrupt data", async () => {
    const storage = fakeStorage();
    storage.setItem("sovrgnnet.connections", "{not json");
    expect(await webConnectionStore(storage).read()).toEqual([]);
  });

  it("ignores stored data of the wrong shape", async () => {
    const storage = fakeStorage();
    storage.setItem("sovrgnnet.connections", '"a string"');
    expect(await webConnectionStore(storage).read()).toEqual([]);
  });
});
