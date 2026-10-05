import * as React from "react";

import { backendFetch } from "./backend-fetch";
import { cachedRequest } from "./cached-request";

/** A hook answering "may this account use X?" from a backend probe that says
 *  200 for yes. Asked once per page and kept, since the answer only changes
 *  with the deployment's account lists; false until it answers. */
export function createAccessHook(path: string): () => boolean {
  const access = cachedRequest(() => backendFetch(path).then((response) => response.ok));
  return function useAccess(): boolean {
    const [allowed, setAllowed] = React.useState(() => access.peek() ?? false);
    React.useEffect(() => {
      let live = true;
      access.get().then(
        (ok) => {
          if (live) setAllowed(ok);
        },
        () => {},
      );
      return () => {
        live = false;
      };
    }, []);
    return allowed;
  };
}

/** Whether this account runs the deployment (OPERATOR_ACCOUNTS): only then does
 *  the product show where sandboxes come from. Everyone else reads "Cloud". */
export const useOperatorAccess = createAccessHook("/api/operator/access");
