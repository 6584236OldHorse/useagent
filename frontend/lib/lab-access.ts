import * as React from "react";

import { backendFetch } from "./backend-fetch";
import { cachedRequest } from "./cached-request";

// Whether this account may open the component lab; asked once per page and
// kept, since the answer only changes with the deployment's LAB_ACCOUNTS.
const labAccess = cachedRequest(() => backendFetch("/api/lab/access").then((response) => response.ok));

export function useLabAccess(): boolean {
  const [allowed, setAllowed] = React.useState(() => labAccess.peek() ?? false);
  React.useEffect(() => {
    let live = true;
    labAccess.get().then(
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
}
