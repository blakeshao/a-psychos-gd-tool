// The first-run document: a four-layer poster wired up as a worked example of
// the tool (image treatments, scatter layouts, text on a sampled path). It is
// only the fallback when no saved document exists — every edit persists to
// localStorage, so a returning visitor sees their own work, not this.
//
// The Image nodes reference /factory-image.jpg from public/ instead of the
// usual embedded data: URI, keeping this module small; the app serves the
// asset from the same origin, so the fetch in Image.cook works unchanged.

import type { Doc } from './engine/graph';

export const factoryDoc: Doc = {
  frame: {
    width: 2480,
    height: 3508,
  },
  layers: [
    {
      id: 'layer_2',
      name: 'Layer 2',
      visible: true,
      opacity: 1,
      blendMode: 'normal',
      graph: {
        nodes: {
          out: {
            id: 'out',
            type: 'Output',
            params: {
              transparent: true,
            },
            position: {
              x: 1035.1364339948243,
              y: 151.17368869190122,
            },
          },
          image_1: {
            id: 'image_1',
            type: 'Image',
            params: {
              src: '/factory-image.jpg',
              fit: 'cover',
              scaleX: 1,
              scaleY: 1,
              offsetX: 0,
              offsetY: 0,
              rotation: 0,
              opacity: 1,
            },
            position: {
              x: 83.20649699139025,
              y: 76.37621545676018,
            },
          },
          ascii_2: {
            id: 'ascii_2',
            type: 'ASCII',
            params: {
              cell: 4,
            },
            position: {
              x: 350.7662863365296,
              y: -28.022151752362202,
            },
          },
          dither_3: {
            id: 'dither_3',
            type: 'Dither',
            params: {
              levels: 8,
              scale: 7,
            },
            position: {
              x: 520.8864049274963,
              y: 366.02853165277065,
            },
          },
          recolor_4: {
            id: 'recolor_4',
            type: 'Recolor',
            params: {
              dark: '#ffffff',
              light: '#007bff',
            },
            position: {
              x: 644.9187022757383,
              y: -24.06537549096177,
            },
          },
          blur_1: {
            id: 'blur_1',
            type: 'Blur',
            params: {
              radius: 28,
            },
            position: {
              x: 526.0481199182425,
              y: 212.56746174450734,
            },
          },
        },
        edges: [
          {
            from: {
              node: 'image_1',
              socket: 'out',
            },
            to: {
              node: 'ascii_2',
              socket: 'in',
            },
          },
          {
            from: {
              node: 'image_1',
              socket: 'out',
            },
            to: {
              node: 'dither_3',
              socket: 'in',
            },
          },
          {
            from: {
              node: 'ascii_2',
              socket: 'out',
            },
            to: {
              node: 'recolor_4',
              socket: 'in',
            },
          },
          {
            from: {
              node: 'image_1',
              socket: 'out',
            },
            to: {
              node: 'blur_1',
              socket: 'in',
            },
          },
          {
            from: {
              node: 'blur_1',
              socket: 'out',
            },
            to: {
              node: 'out',
              socket: 'in',
            },
          },
        ],
      },
    },
    {
      id: 'layer_3',
      name: 'Layer 3',
      visible: true,
      opacity: 1,
      blendMode: 'normal',
      graph: {
        nodes: {
          out: {
            id: 'out',
            type: 'Output',
            params: {
              transparent: true,
            },
            position: {
              x: 1156.8874695603652,
              y: 133.77298778176308,
            },
          },
          shape_1: {
            id: 'shape_1',
            type: 'Shape',
            params: {
              kind: 'ellipse',
              width: 1000,
              height: 1000,
              sides: 6,
              fill: '#ffffff',
              stroke: true,
              strokeColor: '#ffffff',
              strokeWidth: 4,
              strokeAlign: 'center',
              filled: false,
            },
            position: {
              x: 56.02142912179204,
              y: 135.76487796122115,
            },
          },
          rasterize_2: {
            id: 'rasterize_2',
            type: 'Rasterize',
            params: {},
            position: {
              x: 341.72081111557947,
              y: 65.76756494884042,
            },
          },
          random_1: {
            id: 'random_1',
            type: 'Random',
            params: {
              distribution: 'uniform',
              spacing: 354,
              areaWidth: 2750,
              areaHeight: 3501,
              offset: 0,
              rotate: 0,
              scaleJitter: 0.21,
              seed: 1,
            },
            position: {
              x: 231.71509583071946,
              y: 456.49636286093926,
            },
          },
          duplicator_2: {
            id: 'duplicator_2',
            type: 'Duplicator',
            params: {
              count: 18,
            },
            position: {
              x: 596.8116828482882,
              y: 77.32166524620925,
            },
          },
          place_3: {
            id: 'place_3',
            type: 'Place',
            params: {
              distribute: 'by-order',
              offsetX: 0,
              offsetY: 0,
              order: 'progress',
              reverse: 'no',
              seed: 0,
              binds: '[{"channel":"noise","target":"scale","amount":0.75,"invert":false,"offset":0}]',
            },
            position: {
              x: 901.2403745157196,
              y: 179.72751723091898,
            },
          },
          weight_4: {
            id: 'weight_4',
            type: 'Weight',
            params: {
              source: 'noise',
              seed: 851,
              expr: '1 - progress',
            },
            position: {
              x: 529.3333622369977,
              y: 339.3914929425299,
            },
          },
        },
        edges: [
          {
            from: {
              node: 'shape_1',
              socket: 'out',
            },
            to: {
              node: 'rasterize_2',
              socket: 'vector',
            },
          },
          {
            from: {
              node: 'rasterize_2',
              socket: 'out',
            },
            to: {
              node: 'duplicator_2',
              socket: 'in',
            },
          },
          {
            from: {
              node: 'duplicator_2',
              socket: 'out',
            },
            to: {
              node: 'place_3',
              socket: 'elements',
            },
          },
          {
            from: {
              node: 'place_3',
              socket: 'out',
            },
            to: {
              node: 'out',
              socket: 'in',
            },
          },
          {
            from: {
              node: 'random_1',
              socket: 'out',
            },
            to: {
              node: 'weight_4',
              socket: 'layout',
            },
          },
          {
            from: {
              node: 'weight_4',
              socket: 'out',
            },
            to: {
              node: 'place_3',
              socket: 'layout',
            },
          },
        ],
      },
    },
    {
      id: 'layer_1',
      name: 'Layer 1',
      visible: true,
      opacity: 1,
      blendMode: 'normal',
      graph: {
        nodes: {
          text1: {
            id: 'text1',
            type: 'Text',
            params: {
              content: 'Hello\n',
              fontSize: 51,
              font: 'Helvetica',
              fill: '#ffffff',
              weight: 650,
              stroke: true,
              strokeColor: '#ffffff',
              strokeWidth: 1,
              strokeAlign: 'outside',
            },
            position: {
              x: -130.82383685982302,
              y: 68.17727104873936,
            },
          },
          outline1: {
            id: 'outline1',
            type: 'Outline',
            params: {},
            position: {
              x: 124.04386223447906,
              y: 74.35602227427867,
            },
          },
          raster1: {
            id: 'raster1',
            type: 'Rasterize',
            params: {},
            position: {
              x: 635.8517644836397,
              y: 73.35345984285254,
            },
          },
          blur1: {
            id: 'blur1',
            type: 'Blur',
            params: {
              radius: 0,
            },
            position: {
              x: 890.6606498436327,
              y: 45.182974606866125,
            },
          },
          out: {
            id: 'out',
            type: 'Output',
            params: {
              background: '#7300a8',
              transparent: true,
            },
            position: {
              x: 2243.0925487141303,
              y: 163.16556407189282,
            },
          },
          duplicator_1: {
            id: 'duplicator_1',
            type: 'Duplicator',
            params: {
              count: 999,
            },
            position: {
              x: 1137.5905182132612,
              y: 84.64794786478056,
            },
          },
          displace_3: {
            id: 'displace_3',
            type: 'Displace',
            params: {
              amount: 0,
              scale: 391,
              seed: 0,
            },
            position: {
              x: 403.3596075024788,
              y: -18.315986052619277,
            },
          },
          place_4: {
            id: 'place_4',
            type: 'Place',
            params: {
              distribute: 'by-order',
              offsetX: 0,
              offsetY: -139,
              order: 'random',
              reverse: 'yes',
              seed: 0,
              binds: '[]',
            },
            position: {
              x: 1339.3599846683667,
              y: 265.6390692077037,
            },
          },
          warp_9: {
            id: 'warp_9',
            type: 'Warp',
            params: {
              axis: 'x',
              amplitude: 59,
              wavelength: 653,
              phase: 0,
            },
            position: {
              x: 394.9448331691991,
              y: 171.3860925160771,
            },
          },
          image_5: {
            id: 'image_5',
            type: 'Image',
            params: {
              src: '/factory-image.jpg',
              fit: 'cover',
              scaleX: 1,
              scaleY: 1,
              offsetX: 1,
              offsetY: 0,
              rotation: 0,
              opacity: 1,
            },
            position: {
              x: 218.6975032634944,
              y: 617.6634132889558,
            },
          },
          weight_6: {
            id: 'weight_6',
            type: 'Weight',
            params: {
              source: 'image luma',
              seed: 1,
              expr: '1 - progress',
            },
            position: {
              x: 1219.4086183783045,
              y: 1191.0958349439559,
            },
          },
          filter_7: {
            id: 'filter_7',
            type: 'Filter',
            params: {
              mode: 'threshold',
              n: 2,
              channel: 'image luma',
              comparison: 'above',
              threshold: 0.19,
              keep: 0.5,
              seed: 1,
            },
            position: {
              x: 1445.2781702389575,
              y: 1196.0804066972355,
            },
          },
          grid_1: {
            id: 'grid_1',
            type: 'Grid',
            params: {
              columns: 64,
              rows: 45,
              gapX: 133,
              gapY: 41,
              padding: 'x/y',
              padX: 48,
              padY: 48,
              padTop: 48,
              padRight: 48,
              padBottom: 48,
              padLeft: 48,
              distX: 'uniform',
              distY: 'uniform',
              ratioX: 1.618,
              ratioY: 1.618,
              weightsX: '1,1,2,3,5',
              weightsY: '1,1,2,3,5',
              exprX: '1 + sin(t*pi)',
              exprY: '1 + sin(t*pi)',
              reverseX: 'no',
              reverseY: 'no',
              stagger: 'none',
              flow: 'rows',
            },
            position: {
              x: 877.9668859533214,
              y: 394.2214074203013,
            },
          },
          toalpha_1: {
            id: 'toalpha_1',
            type: 'ToAlpha',
            params: {
              source: 'luminance',
              invert: 'no',
              threshold: 0.51,
              softness: 0.25,
            },
            position: {
              x: 521.0575376939682,
              y: 500.6884775159913,
            },
          },
          samplepath_1: {
            id: 'samplepath_1',
            type: 'SamplePath',
            params: {
              gap: 40,
              offset: 0,
              tangent: 'rotate',
            },
            position: {
              x: 502.32974043869535,
              y: 708.3055349054033,
            },
          },
          random_3: {
            id: 'random_3',
            type: 'Random',
            params: {
              count: 999,
              areaWidth: 1049,
              areaHeight: 1093,
              offset: 0,
              rotate: 0,
              scaleJitter: 0,
              seed: 1,
              distribution: 'uniform',
              spacing: 10,
            },
            position: {
              x: 1211.7747598135343,
              y: 778.2180098386843,
            },
          },
          duplicator_7: {
            id: 'duplicator_7',
            type: 'Duplicator',
            params: {
              count: 5,
            },
            position: {
              x: 1655.7220543440599,
              y: 105.32702626078,
            },
          },
          place_8: {
            id: 'place_8',
            type: 'Place',
            params: {
              distribute: 'by-order',
              offsetX: 0,
              offsetY: 0,
              order: 'source',
              reverse: 'no',
              seed: 0,
              binds: '[]',
            },
            position: {
              x: 1972.3068241079507,
              y: 152.00539974788913,
            },
          },
          grid_9: {
            id: 'grid_9',
            type: 'Grid',
            params: {
              columns: 1,
              rows: 5,
              gapX: 0,
              gapY: 0,
              padding: 'x/y',
              padX: 0,
              padY: 0,
              padTop: 48,
              padRight: 48,
              padBottom: 48,
              padLeft: 48,
              distX: 'uniform',
              distY: 'uniform',
              ratioX: 1.618,
              ratioY: 1.618,
              weightsX: '1,1,2,3,5',
              weightsY: '1,1,2,3,5',
              exprX: '1 + sin(t*pi)',
              exprY: '1 + sin(t*pi)',
              reverseX: 'no',
              reverseY: 'no',
              stagger: 'none',
              flow: 'rows',
            },
            position: {
              x: 1662.8978130326223,
              y: 270.67270681034694,
            },
          },
        },
        edges: [
          {
            from: {
              node: 'text1',
              socket: 'out',
            },
            to: {
              node: 'outline1',
              socket: 'text',
            },
          },
          {
            from: {
              node: 'raster1',
              socket: 'out',
            },
            to: {
              node: 'blur1',
              socket: 'in',
            },
          },
          {
            from: {
              node: 'blur1',
              socket: 'out',
            },
            to: {
              node: 'duplicator_1',
              socket: 'in',
            },
          },
          {
            from: {
              node: 'outline1',
              socket: 'out',
            },
            to: {
              node: 'displace_3',
              socket: 'in',
            },
          },
          {
            from: {
              node: 'duplicator_1',
              socket: 'out',
            },
            to: {
              node: 'place_4',
              socket: 'elements',
            },
          },
          {
            from: {
              node: 'outline1',
              socket: 'out',
            },
            to: {
              node: 'warp_9',
              socket: 'in',
            },
          },
          {
            from: {
              node: 'displace_3',
              socket: 'out',
            },
            to: {
              node: 'raster1',
              socket: 'vector',
            },
          },
          {
            from: {
              node: 'image_5',
              socket: 'out',
            },
            to: {
              node: 'weight_6',
              socket: 'map',
            },
          },
          {
            from: {
              node: 'weight_6',
              socket: 'out',
            },
            to: {
              node: 'filter_7',
              socket: 'layout',
            },
          },
          {
            from: {
              node: 'grid_1',
              socket: 'out',
            },
            to: {
              node: 'weight_6',
              socket: 'layout',
            },
          },
          {
            from: {
              node: 'image_5',
              socket: 'out',
            },
            to: {
              node: 'toalpha_1',
              socket: 'in',
            },
          },
          {
            from: {
              node: 'toalpha_1',
              socket: 'out',
            },
            to: {
              node: 'grid_1',
              socket: 'mask',
            },
          },
          {
            from: {
              node: 'toalpha_1',
              socket: 'out',
            },
            to: {
              node: 'random_3',
              socket: 'mask',
            },
          },
          {
            from: {
              node: 'place_4',
              socket: 'out',
            },
            to: {
              node: 'duplicator_7',
              socket: 'in',
            },
          },
          {
            from: {
              node: 'duplicator_7',
              socket: 'out',
            },
            to: {
              node: 'place_8',
              socket: 'elements',
            },
          },
          {
            from: {
              node: 'grid_9',
              socket: 'out',
            },
            to: {
              node: 'place_8',
              socket: 'layout',
            },
          },
          {
            from: {
              node: 'place_4',
              socket: 'out',
            },
            to: {
              node: 'out',
              socket: 'in',
            },
          },
          {
            from: {
              node: 'grid_1',
              socket: 'out',
            },
            to: {
              node: 'place_4',
              socket: 'layout',
            },
          },
        ],
      },
    },
    {
      id: 'layer_4',
      name: 'Layer 4',
      visible: true,
      opacity: 1,
      blendMode: 'normal',
      graph: {
        nodes: {
          out: {
            id: 'out',
            type: 'Output',
            params: {
              transparent: true,
            },
            position: {
              x: 921.1382756769927,
              y: 206.51751191392668,
            },
          },
          shape_5: {
            id: 'shape_5',
            type: 'Shape',
            params: {
              kind: 'rect',
              width: 300,
              height: 300,
              sides: 6,
              filled: true,
              fill: '#ffffff',
              stroke: true,
              strokeColor: '#ffffff',
              strokeWidth: 4,
              strokeAlign: 'center',
            },
            position: {
              x: -345.6491821417935,
              y: 107.44283241524805,
            },
          },
          rasterize_6: {
            id: 'rasterize_6',
            type: 'Rasterize',
            params: {},
            position: {
              x: -85.61275194344455,
              y: 110.46388132877401,
            },
          },
          duplicator_7: {
            id: 'duplicator_7',
            type: 'Duplicator',
            params: {
              count: 39,
            },
            position: {
              x: 191.83797670673493,
              y: 108.45820260573922,
            },
          },
          place_8: {
            id: 'place_8',
            type: 'Place',
            params: {
              distribute: 'by-order',
              offsetX: 0,
              offsetY: 0,
              order: 'source',
              reverse: 'no',
              seed: 0,
              binds: '[]',
            },
            position: {
              x: 620.0849365462205,
              y: 237.77178086411402,
            },
          },
          grid_9: {
            id: 'grid_9',
            type: 'Grid',
            params: {
              columns: 7,
              rows: 10,
              gapX: 0,
              gapY: 0,
              padding: 'x/y',
              padX: 0,
              padY: 0,
              padTop: 48,
              padRight: 48,
              padBottom: 48,
              padLeft: 48,
              distX: 'uniform',
              distY: 'uniform',
              ratioX: 1.618,
              ratioY: 1.618,
              weightsX: '1,1,2,3,5',
              weightsY: '1,1,2,3,5',
              exprX: '1 + sin(t*pi)',
              exprY: '1 + sin(t*pi)',
              reverseX: 'no',
              reverseY: 'no',
              stagger: 'none',
              flow: 'rows',
            },
            position: {
              x: -376.04798130968294,
              y: 430.59884873276667,
            },
          },
          filter_10: {
            id: 'filter_10',
            type: 'Filter',
            params: {
              mode: 'threshold',
              n: 3,
              channel: 'image luma',
              comparison: 'below',
              threshold: 0.38,
              keep: 0.27,
              seed: 416,
            },
            position: {
              x: 128.22645402838154,
              y: 452.65894327027786,
            },
          },
          image_11: {
            id: 'image_11',
            type: 'Image',
            params: {
              src: '/factory-image.jpg',
              fit: 'cover',
              scaleX: 1,
              scaleY: 1,
              offsetX: 0,
              offsetY: 0,
              rotation: 0,
              opacity: 1,
            },
            position: {
              x: -375.96795793053764,
              y: 775.8229176807936,
            },
          },
          weight_13: {
            id: 'weight_13',
            type: 'Weight',
            params: {
              source: 'image luma',
              seed: 1,
              expr: '1 - progress',
            },
            position: {
              x: -101.73065204834599,
              y: 476.27018543048325,
            },
          },
          filter_14: {
            id: 'filter_14',
            type: 'Filter',
            params: {
              mode: 'random',
              n: 2,
              channel: 'weight',
              comparison: 'above',
              threshold: 0.5,
              keep: 0.57,
              seed: 1764,
            },
            position: {
              x: 381.445527111139,
              y: 441.07817373121344,
            },
          },
        },
        edges: [
          {
            from: {
              node: 'shape_5',
              socket: 'out',
            },
            to: {
              node: 'rasterize_6',
              socket: 'vector',
            },
          },
          {
            from: {
              node: 'rasterize_6',
              socket: 'out',
            },
            to: {
              node: 'duplicator_7',
              socket: 'in',
            },
          },
          {
            from: {
              node: 'duplicator_7',
              socket: 'out',
            },
            to: {
              node: 'place_8',
              socket: 'elements',
            },
          },
          {
            from: {
              node: 'place_8',
              socket: 'out',
            },
            to: {
              node: 'out',
              socket: 'in',
            },
          },
          {
            from: {
              node: 'image_11',
              socket: 'out',
            },
            to: {
              node: 'weight_13',
              socket: 'map',
            },
          },
          {
            from: {
              node: 'grid_9',
              socket: 'out',
            },
            to: {
              node: 'weight_13',
              socket: 'layout',
            },
          },
          {
            from: {
              node: 'weight_13',
              socket: 'out',
            },
            to: {
              node: 'filter_10',
              socket: 'layout',
            },
          },
          {
            from: {
              node: 'filter_10',
              socket: 'out',
            },
            to: {
              node: 'filter_14',
              socket: 'layout',
            },
          },
          {
            from: {
              node: 'filter_14',
              socket: 'out',
            },
            to: {
              node: 'place_8',
              socket: 'layout',
            },
          },
        ],
      },
    },
  ],
};
