import { Button } from "@/components/base/buttons/button";
import type { AvailableNativeFactor } from "./identity-flow";
import { nativeFactorKey, nativeFactorLabel } from "./identity-flow";
import { IdentityFormShell, IdentityStatus } from "./identity-form-layout";

export function IdentityFactorChoices({
  factors,
  pending,
  error,
  onSelect,
}: {
  factors: AvailableNativeFactor[];
  pending: boolean;
  error: string | null;
  onSelect: (factor: AvailableNativeFactor) => void;
}) {
  if (!factors.length) {
    return (
      <IdentityStatus
        title="Additional verification required"
        message="This account requires a verification method that is not supported by this native sign-in screen."
        error
      />
    );
  }
  return (
    <IdentityFormShell mode="sign-in" error={error}>
      <div className="mt-8 flex flex-col gap-3">
        {factors.map((factor) => (
          <Button
            key={nativeFactorKey(factor)}
            type="button"
            variant="secondary"
            className="h-10 w-full rounded-full"
            disabled={pending}
            onClick={() => onSelect(factor)}
          >
            {nativeFactorLabel(factor)}
          </Button>
        ))}
      </div>
    </IdentityFormShell>
  );
}
