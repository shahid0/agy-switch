import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { harnessBinary } from "./paths.ts";

export type LoginResult = {
  acpToken: {
    client_id: string;
    client_secret: string;
    refresh_token: string;
    token_uri: string;
    scopes: string[];
    project_id?: string;
  };
  grantedScopes: string[];
  accessToken: string;
  idToken?: string;
  expiresAt: number;
  email: string;
  name: string;
  subscription: { id: string; name: string } | null;
};

const AUTH_URL_PREFIX = "Open the following link to authenticate the ACP server: ";

/**
 * Run one Google sign-in through the bundled ACP harness.
 *
 * The harness owns the PKCE exchange and writes the token itself, so this
 * delegates rather than reimplementing OAuth: we only supply an isolated
 * GEMINI_HOME, surface the authorize URL, and read the token it produces.
 */
export async function login(opts: {
  openUrl?: (url: string) => void;
  timeoutMs?: number;
  onUrl?: (url: string) => void;
  log?: (line: string) => void;
} = {}): Promise<LoginResult> {
  const binary = harnessBinary();
  if (!binary) {
    throw new Error(
      "The Antigravity ACP harness is not installed.\n" +
        "It ships with T3 Code. Install T3 Code once, or point AGY_SWITCH_HARNESS at an agy_acp_server.par.",
    );
  }

  const timeoutMs = opts.timeoutMs ?? 5 * 60_000;
  const log = opts.log ?? (() => {});

  // Isolated profile: the harness refuses to start without settings.json.
  const profile = mkdtempSync(join(tmpdir(), "agy-switch-login-"));
  const acpDir = join(profile, "antigravity-acp");
  mkdirSync(acpDir, { recursive: true });
  writeFileSync(join(acpDir, "settings.json"), JSON.stringify({ auth: { type: "oauth-personal" } }));
  const tokenPath = join(acpDir, "acp_token.json");

  const child = spawn(binary, [], {
    cwd: profile,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      // Deliberately minimal: inherited GEMINI_HOME / API keys would point the
      // harness at another profile or bypass the interactive flow entirely.
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: process.env.HOME ?? "",
      GEMINI_HOME: profile,
      AGY_ACP_FORCE_FILE_STORAGE: "1",
      PYTHONUNBUFFERED: "1",
      TMPDIR: join(acpDir, "tmp"),
    },
  });

  const finish = () => {
    child.kill();
    rmSync(profile, { recursive: true, force: true });
  };

  const send = (payload: unknown) => {
    child.stdin?.write(`${JSON.stringify(payload)}\n`);
  };

  const deadline = Date.now() + timeoutMs;
  let urlSent = false;
  let stderrTail = "";

  const result = await new Promise<LoginResult>((resolve, reject) => {
    let settled = false;
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };

    const timer = setTimeout(
      () => done(() => reject(new Error(`Sign-in timed out after ${Math.round(timeoutMs / 1000)}s.`))),
      timeoutMs,
    );

    // Poll for the token file: the harness writes it after the callback.
    const poll = setInterval(() => {
      if (Date.now() > deadline) return;
      if (!existsSync(tokenPath)) return;
      try {
        const token = JSON.parse(readFileSync(tokenPath, "utf8"));
        if (!token?.refresh_token) return;
        // Give the harness a moment to finish its own bookkeeping.
        setTimeout(() => {
          void (async () => {
            try {
              const ident = await identify(token);
              clearTimeout(timer);
              done(() => resolve({ acpToken: token, ...ident }));
            } catch (err) {
              clearTimeout(timer);
              done(() => reject(err));
            }
          })();
        }, 500);
      } catch {
        /* file mid-write; try again */
      }
    }, 400);

    const cleanupIntervals = () => clearInterval(poll);

    child.stderr?.on("data", (buf: Buffer) => {
      const text = buf.toString();
      stderrTail = (stderrTail + text).slice(-4000);
      for (const line of text.split("\n")) {
        if (!line.includes(AUTH_URL_PREFIX)) continue;
        const url = line.slice(line.indexOf(AUTH_URL_PREFIX) + AUTH_URL_PREFIX.length).trim();
        if (urlSent) continue;
        urlSent = true;
        opts.onUrl?.(url);
        opts.openUrl?.(url);
      }
    });

    child.stdout?.on("data", (buf: Buffer) => {
      for (const line of buf.toString().split("\n")) {
        if (!line.startsWith("{")) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id === 1 && msg.result?.authMethods) {
            // initialize answered: start Google sign-in.
            send({ jsonrpc: "2.0", id: 2, method: "authenticate", params: { methodId: "oauth-personal" } });
          }
          if (msg.id === 2 && msg.error) {
            clearTimeout(timer);
            cleanupIntervals();
            done(() => reject(new Error(`Sign-in failed: ${JSON.stringify(msg.error).slice(0, 300)}`)));
          }
        } catch {
          /* not a JSON-RPC line */
        }
      }
    });

    child.on("exit", (code) => {
      cleanupIntervals();
      if (existsSync(tokenPath)) {
        // Token landed; the poll will resolve. Don't reject on exit.
        log(`harness exited (${code}) after writing credentials`);
        return;
      }
      clearTimeout(timer);
      done(() =>
        reject(
          new Error(
            `The sign-in harness exited (code ${code}) without writing credentials.\n` +
              (stderrTail ? `Last output:\n${stderrTail}` : ""),
          ),
        ),
      );
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      cleanupIntervals();
      done(() => reject(err));
    });

    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1, clientCapabilities: {} } });
  });

  finish();
  return result;
}

/** Ask Google who the token belongs to, what it may do, and the plan it is on. */
async function identify(token: {
  client_id: string;
  client_secret: string;
  refresh_token: string;
  project_id?: string;
}): Promise<Omit<LoginResult, "acpToken">> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: token.client_id,
      client_secret: token.client_secret,
      refresh_token: token.refresh_token,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) {
    throw new Error(`Google rejected the new credential (HTTP ${res.status}): ${(await res.text()).slice(0, 300)}`);
  }
  const grant = (await res.json()) as {
    access_token: string;
    expires_in: number;
    id_token?: string;
    scope?: string;
  };

  const info = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
    headers: { Authorization: `Bearer ${grant.access_token}` },
  });
  if (!info.ok) throw new Error(`Could not read the account identity (HTTP ${info.status}).`);
  const who = (await info.json()) as { email?: string; name?: string };

  return {
    grantedScopes: (grant.scope ?? "").split(/\s+/).filter(Boolean),
    accessToken: grant.access_token,
    idToken: grant.id_token,
    expiresAt: Date.now() + Math.max(60, grant.expires_in - 60) * 1000,
    email: who.email ?? "",
    name: who.name ?? who.email ?? "",
    subscription: null,
  };
}
