import { createAccessHook } from "./account-access";

// Whether this account may open the component lab (the deployment's LAB_ACCOUNTS).
export const useLabAccess = createAccessHook("/api/lab/access");
