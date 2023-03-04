import { error, goaway } from "./spdy/constants.ts";

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
};

export type HeadersFrame = {
  type: 'HEADERS',
  id: number,
  priority: {parent: number; exclusive: boolean; weight: number},
  fin: boolean,
  writable: boolean,
  headers: Record<string,string>,
  path?: unknown,
};

export type PushPromiseFrame = {
  type: 'PUSH_PROMISE',
  id: number,
  fin: boolean,
  promisedId: number,
  headers: Record<string,string>,
  path?: unknown,
};

export type RstFrame = {
  type: 'RST',
  id: number;
  code: keyof typeof error
  extra?: Uint8Array;
}

export type SettingsKey =
  | 'upload_bandwidth'
  | 'download_bandwidth'
  | 'round_trip_time'
  | 'max_concurrent_streams'
  | 'current_cwnd'
  | 'download_retrans_rate'
  | 'initial_window_size'
  | 'client_certificate_vector_size'
;

export type SettingsFrame = {
  type: 'SETTINGS',
  id?: undefined,
  settings: Partial<Record<SettingsKey, number>>;
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
  code: keyof typeof goaway,
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

/** HTTP2-specific */
export type AckSettingsFrame = {
  type: 'ACK_SETTINGS';
  id: undefined;
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
