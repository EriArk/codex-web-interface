import type { MachineConfig } from "@codex-web/shared";

// Runtime capability, deliberately absent from serialized configuration and browser contracts.
const owners = new WeakMap<MachineConfig, () => void>();
export function bindMachineAuthority(machine: MachineConfig, authorize: () => void) {
  if (owners.has(machine)) throw new Error("MACHINE_AUTHORITY_ALREADY_BOUND");
  owners.set(machine, authorize);
  return () => {
    if (owners.get(machine) === authorize)
      owners.set(machine, () => {
        throw new Error("MACHINE_RUNTIME_CLOSED");
      });
  };
}
export function authorizeMachine(machine: MachineConfig) {
  owners.get(machine)?.();
}
