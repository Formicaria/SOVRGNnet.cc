import { describe, it, expect } from "vitest";
import { createClient } from "@supabase/supabase-js";

describe("Supabase Auth Configuration", () => {
  it("should have valid Supabase credentials", () => {
    const supabaseUrl = process.env.VITE_SUPABASE_URL;
    const supabaseAnonKey = process.env.VITE_SUPABASE_ANON_KEY;

    expect(supabaseUrl).toBeDefined();
    expect(supabaseAnonKey).toBeDefined();
    expect(supabaseUrl).toMatch(/^https:\/\/.*\.supabase\.co$/);
    expect(supabaseAnonKey?.length).toBeGreaterThan(0);
  });

  it("should be able to create Supabase client", () => {
    const supabaseUrl = process.env.VITE_SUPABASE_URL;
    const supabaseAnonKey = process.env.VITE_SUPABASE_ANON_KEY;

    if (!supabaseUrl || !supabaseAnonKey) {
      throw new Error("Missing Supabase credentials");
    }

    const client = createClient(supabaseUrl, supabaseAnonKey);
    expect(client).toBeDefined();
    expect(client.auth).toBeDefined();
  });
});
