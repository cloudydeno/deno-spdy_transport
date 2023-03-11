export type HpackHeader = {
  incremental?: boolean;
  huffman?: boolean;
  name: string;
  value: string;
  neverIndex?: boolean;
}
