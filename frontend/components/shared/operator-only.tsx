"use client";

import type { ReactNode } from "react";

import { useOperatorAccess } from "@/lib/account-access";

/** Renders its children for an operator account (OPERATOR_ACCOUNTS) and nothing
 *  for anyone else, including while the answer is still loading. */
export function OperatorOnly({ children }: { readonly children: ReactNode }) {
  return useOperatorAccess() ? children : null;
}
