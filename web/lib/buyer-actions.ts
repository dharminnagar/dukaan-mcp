"use server";

/**
 * Server actions for the buyer-facing pages, called directly from client
 * components exactly like `web/app/actions.ts`'s `onboard` — no
 * `<form action>`, just an async function a "use client" page awaits and
 * wraps in try/catch.
 */
import "./assert-server-only";
import { cookies } from "next/headers";
import {
  DuplicateEmailError,
  InvalidCredentialsError,
  SESSION_COOKIE_NAME,
  loginBuyer,
  logoutBuyer,
  registerBuyer,
} from "../../src/buyer/auth";
import {
  AlreadyConnectedError,
  NotConnectedError,
  provisionAgentForBuyer,
  rotateAgentToken,
} from "../../src/buyer/provision";
import { rupeesToPaise } from "../../src/catalog/csv";
import { getSessionBuyer, merchantExists } from "./buyer-queries";

/**
 * Same source `web/app/actions.ts` uses. Never bare `process.env.PORT` —
 * inside Next that is Next's own port, not the MCP server's.
 */
const MCP_HOST = process.env["MCP_HOST"] ?? "127.0.0.1";
const MCP_PORT = process.env["MCP_PORT"] ?? "8787";
const MCP_ENDPOINT =
  process.env["MCP_PUBLIC_URL"] ?? `http://${MCP_HOST}:${MCP_PORT}/mcp`;

const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30; // 30 days, matches src/buyer/auth.ts

async function setSessionCookie(rawToken: string): Promise<void> {
  const store = await cookies();
  store.set(SESSION_COOKIE_NAME, rawToken, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure: process.env["NODE_ENV"] === "production",
    maxAge: SESSION_MAX_AGE_SECONDS,
  });
}

export interface BuyerAccount {
  readonly id: string;
  readonly email: string;
}

export async function register(
  email: string,
  password: string
): Promise<BuyerAccount> {
  let result: Awaited<ReturnType<typeof registerBuyer>>;
  try {
    result = await registerBuyer(email, password);
  } catch (err) {
    if (err instanceof DuplicateEmailError) {
      throw new Error(
        `An account with that email already exists. Log in instead.`,
        { cause: err }
      );
    }
    throw err;
  }
  await setSessionCookie(result.session.raw);
  return { id: result.buyer.id, email: result.buyer.email };
}

export async function login(
  email: string,
  password: string
): Promise<BuyerAccount> {
  let result: Awaited<ReturnType<typeof loginBuyer>>;
  try {
    result = await loginBuyer(email, password);
  } catch (err) {
    if (err instanceof InvalidCredentialsError) {
      throw new Error("Invalid email or password.", { cause: err });
    }
    throw err;
  }
  await setSessionCookie(result.session.raw);
  return { id: result.buyer.id, email: result.buyer.email };
}

export async function logout(): Promise<void> {
  const store = await cookies();
  const raw = store.get(SESSION_COOKIE_NAME)?.value;
  if (raw !== undefined) await logoutBuyer(raw);
  store.delete(SESSION_COOKIE_NAME);
}

export interface ConnectResult {
  readonly token: string;
  readonly endpoint: string;
  readonly agentId: string;
  readonly buyerCapPaise: number | null;
}

/**
 * Mints an agent for the signed-in buyer at `merchantId`. `buyerCapRupees`
 * is optional and blank means no buyer-set cap, converted with the same
 * `rupeesToPaise` `createMerchant` uses — never a float in the browser.
 */
export async function connect(
  merchantId: string,
  buyerCapRupees?: string
): Promise<ConnectResult> {
  const buyer = await getSessionBuyer();
  if (buyer === null) {
    throw new Error("You must be signed in to connect to a store.");
  }
  if (!(await merchantExists(merchantId))) {
    throw new Error(`No such merchant: ${merchantId}.`);
  }

  let buyerCapPaise: number | null = null;
  if (buyerCapRupees !== undefined && buyerCapRupees.trim() !== "") {
    buyerCapPaise = rupeesToPaise(buyerCapRupees);
    if (buyerCapPaise <= 0) {
      throw new Error(
        `Invalid cap ${JSON.stringify(buyerCapRupees)}: must be greater than zero. ` +
          `Leave it blank for no cap.`
      );
    }
  }

  let result: Awaited<ReturnType<typeof provisionAgentForBuyer>>;
  try {
    result = await provisionAgentForBuyer({
      buyerId: buyer.id,
      merchantId,
      label: `buyer-${buyer.id}`,
      buyerCapPaise,
    });
  } catch (err) {
    // Matches web/app/actions.ts's duplicate-merchant-name handling: the ONE
    // failure a buyer hits by accident (double-clicking connect, or
    // reconnecting to a store they already have) gets a human sentence
    // instead of a raw constraint violation.
    if (err instanceof AlreadyConnectedError) {
      throw new Error("You are already connected to this store.", {
        cause: err,
      });
    }
    throw err;
  }

  return {
    token: result.token,
    endpoint: MCP_ENDPOINT,
    agentId: result.agentId,
    buyerCapPaise: result.buyerCapPaise,
  };
}

export async function regenerateToken(
  merchantId: string
): Promise<ConnectResult> {
  const buyer = await getSessionBuyer();
  if (buyer === null) {
    throw new Error("You must be signed in to regenerate a token.");
  }

  let result: Awaited<ReturnType<typeof rotateAgentToken>>;
  try {
    result = await rotateAgentToken({ buyerId: buyer.id, merchantId });
  } catch (err) {
    if (err instanceof NotConnectedError) {
      throw new Error(
        "You are not connected to this store yet — use Connect instead.",
        { cause: err }
      );
    }
    throw err;
  }

  return {
    token: result.token,
    endpoint: MCP_ENDPOINT,
    agentId: result.agentId,
    buyerCapPaise: result.buyerCapPaise,
  };
}
