import { expect, spyOn, test } from "bun:test";
import { db } from "./db/client";
import { seedDev } from "./seed";

test("a production database gets no dev owner account", async () => {
  const insert = spyOn(db, "insert").mockImplementation(() => {
    throw new Error("seeded the dev identity");
  });
  const keys = ["ALLOW_DEV_ORG", "NODE_ENV", "USEAGENT_DEV_MODE"] as const;
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    for (const environment of [
      { ALLOW_DEV_ORG: "0" },
      { NODE_ENV: "production" },
    ] as const) {
      for (const key of keys) delete process.env[key];
      Object.assign(process.env, environment);
      await seedDev();
    }
    expect(insert).not.toHaveBeenCalled();
  } finally {
    insert.mockRestore();
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
});
