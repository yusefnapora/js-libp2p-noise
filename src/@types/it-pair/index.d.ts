export type Duplex = [Stream, Stream];

type Stream = {
  sink(source: Iterable<any>);
  source: Record<string, any>;
}
