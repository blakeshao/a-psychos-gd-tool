declare module 'imagetracerjs' {
  interface TraceSegment {
    type: 'L' | 'Q';
    x1: number; y1: number;
    x2: number; y2: number;
    x3?: number; y3?: number;
  }
  interface TracePath {
    segments: TraceSegment[];
    isholepath: boolean;
  }
  interface TraceData {
    layers: TracePath[][];
    palette: { r: number; g: number; b: number; a: number }[];
    width: number;
    height: number;
  }
  const ImageTracer: {
    imagedataToTracedata(imgd: ImageData, options?: Record<string, number | string>): TraceData;
  };
  export default ImageTracer;
}
