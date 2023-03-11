import { error as SpdyError, goaway as SpdyGoaway, settingsIndex } from "./spdy/constants.ts";
import { error as H2Error, goaway as H2Goaway } from "./http2/constants.ts";
import { PriorityJson } from "../priority.ts";

export type SpdyHeaderValue = string | string[] | number;
export type SpdyHeaders = Record<string, SpdyHeaderValue | undefined>;

export type ClassicCallback<T=never> = (err?: Error | null, value?: T | null) => void;
export type FrameCallback = ClassicCallback<FrameUnion | FrameUnion[]>;

export type FrameHeader = {
  control: boolean,
  version?: number,
  type?: number,
  id?: number;
  flags: number;
  length: number;
};

export type FrameUnion =
  | NoopFrame
  | DataFrame
  | HeadersFrame
  | PushPromiseFrame
  | RstFrame
  | SettingsFrame
  | PingFrame
  | GoawayFrame
  | WindowUpdateFrame
  | XForwardedFrame
  | PriorityFrame
  | AckSettingsFrame
  | FinFrame
  // | SynStreamFrame
  // | SynReplyFrame
;

export type NoopFrame = {
  type: 'NOOP',
  id?: undefined,
};

export type DataFrame = {
  type: 'DATA',
  id: number,
  fin: boolean,
  data: Uint8Array,
  priority?: number | false, // h2 only
};

export type HeadersFrame = {
  type: 'HEADERS',
  id: number,
  priority: PriorityJson,
  fin: boolean,
  writable: boolean,
  headers: null | SpdyHeaders,
  path?: unknown,
};

export type PushPromiseFrame = {
  type: 'PUSH_PROMISE',
  id: number,
  fin: boolean,
  promisedId: number,
  headers: null | SpdyHeaders,
  path?: unknown,
};

export type RstFrame = {
  type: 'RST',
  id: number;
  code: keyof typeof SpdyError | keyof typeof H2Error
  extra?: Uint8Array;
}

export type SpdySettingsKey = (typeof settingsIndex)[number] & string;

export type SettingsFrame = {
  type: 'SETTINGS',
  id?: undefined,
  settings: Partial<Record<SpdySettingsKey, number>>;
};

export type PingFrame = {
  type: 'PING',
  id?: undefined,
  opaque: Uint8Array;
  ack: boolean;
}

export type GoawayFrame = {
  type: 'GOAWAY',
  id?: undefined,
  lastId: number,
  code: keyof typeof SpdyGoaway | keyof typeof H2Goaway,
  debug?: Uint8Array;
}

export type WindowUpdateFrame = {
  type: 'WINDOW_UPDATE',
  id: number,
  delta: number,
}

export type XForwardedFrame = {
  type: 'X_FORWARDED_FOR',
  id?: undefined,
  host: string,
}

/** HTTP2-specific */
export type PriorityFrame = {
  type: 'PRIORITY',
  id: number,
  priority: {
    exclusive: boolean,
    parent: number,
    weight: number,
  },
}

/** HTTP2-specific. Really just an empty SETTINGS with an ACK flag. */
export type AckSettingsFrame = {
  type: 'ACK_SETTINGS';
  id?: undefined;
}

/** Fake frame to simulate end of the data */
export type FinFrame = {
  type: 'FIN';
  fin: true;
  id?: undefined,
}

// /** Only send? */
// export type SynStreamFrame = {
//   type: 'SYN_STREAM',
//   id: number;
//   flags: number
// }
// /** Only send? */
// export type SynReplyFrame = {
//   type: 'SYN_REPLY',
//   id: number;
//   flags: number
// }
