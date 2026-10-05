/**
 * The link protocol version a runner and a control plane speak.
 *
 * Additive rule: a new control frame, a new RPC method, a new stream target or
 * a new OPTIONAL field on an existing frame does not change this number. A
 * peer ignores frames and fields it does not know. Anything else (a removed
 * frame, a field that changes meaning, a field that becomes required) bumps
 * PROTOCOL_VERSION, and the control plane raises the minimum it advertises in
 * `/api/config` (`runner.minProtocol`) once every supported runner has moved.
 */
export const PROTOCOL_VERSION = 2;
// 2: the welcome's image may name a registry login (image.pull); a runner that
//    ignores it cannot pull an image the plane serves, so 1 is no longer enough.
