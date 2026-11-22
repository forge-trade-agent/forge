"use client";
import type { Hex } from "@sealdesk/sdk";
import { api } from "./desk";

export interface BurnState {
  vault: Hex;
  route: Hex | null;
  queued: { route: Hex; eta: string; activatableNow: boolean } | null;
  totalBurnedByVault: string;
  atDeadAddress: string;
  feesWaiting: { asset: Hex; amount: string }[];
  updatedAt: string;
}

export interface DeskStats {
  deals: { accepted: number; settled: number; refunded: number; tokensTraded: number };
  /** Price impact avoided vs a DEX market order of the same size (estimate, per settled deal). */
  savedVsDex?: { usd: string; compared: number; beyondPool: number; noPool: number };
  volumeByPayToken: { payToken: Hex; volume: string; fees: string; volumeUsd: string | null; feesUsd: string | null }[];
  postings: { posted: number; open: number };
  sealedAnswers: number;
  burn: { burnedByVault: string; burns: number; vault: Hex };
  updatedAt: string;
  note: string;
}

export const getBurn = () => api.http.request<BurnState>("GET", "/burn");
export const getStats = () => api.http.request<DeskStats>("GET", "/stats");
