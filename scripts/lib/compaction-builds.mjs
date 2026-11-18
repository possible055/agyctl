const PROMPT_SEGMENTS = [
  {
    name: 'summary-prompt-raw',
    role: 'prompt',
    encoding: 'raw',
    va: '0x143c2a28d',
    offset: 0x3c2968d,
    preimageSha256: 'adc0b546b4512337f3edc1080cbcdf2d4b9303345664815694024e7304898a1c',
  },
  {
    name: 'summary-prompt-json-1',
    role: 'prompt',
    encoding: 'json',
    va: '0x149e5ffea',
    offset: 0x9e5edea,
    preimageSha256: 'ec1fb15144962801251eeb9521b88b22c4b110e16b89916e61e7c2ffe981f081',
  },
  {
    name: 'summary-prompt-json-2',
    role: 'prompt',
    encoding: 'json',
    va: '0x149e62da4',
    offset: 0x9e61ba4,
    preimageSha256: 'ec1fb15144962801251eeb9521b88b22c4b110e16b89916e61e7c2ffe981f081',
  },
];
const REQUEST_COUNT_SITES = [
  {
    name: 'max-user-requests-gemini-2.5-flash',
    profile: 'MODEL_GOOGLE_GEMINI_2_5_FLASH',
    va: '0x149e5f275',
    offset: 0x9e5e075,
  },
  {
    name: 'max-user-requests-gemini-2.5-pro',
    profile: 'MODEL_GOOGLE_GEMINI_2_5_PRO',
    va: '0x149e5f67b',
    offset: 0x9e5e47b,
  },
  {
    name: 'max-user-requests-gpt-oss-120b-medium',
    profile: 'MODEL_OPENAI_GPT_OSS_120B_MEDIUM',
    va: '0x149e5fa54',
    offset: 0x9e5e854,
  },
  {
    name: 'max-user-requests-m124-base',
    profile: 'MODEL_PLACEHOLDER_M124',
    va: '0x149e5fe22',
    offset: 0x9e5ec22,
  },
  {
    name: 'max-user-requests-m26-base',
    profile: 'MODEL_PLACEHOLDER_M26',
    va: '0x149e61456',
    offset: 0x9e60256,
  },
  {
    name: 'max-user-requests-m400-base',
    profile: 'MODEL_PLACEHOLDER_M400',
    va: '0x149e62429',
    offset: 0x9e61229,
  },
  {
    name: 'max-user-requests-m400-claude-1m-840k',
    profile: 'MODEL_PLACEHOLDER_M400/claude-1m_840k',
    va: '0x149e627e0',
    offset: 0x9e615e0,
  },
  {
    name: 'max-user-requests-m408-base',
    profile: 'MODEL_PLACEHOLDER_M408',
    va: '0x149e62bdc',
    offset: 0x9e619dc,
  },
];
const IMM32_SITES = [
  {
    name: 'max-user-request-bytes-imm32',
    field: '[rax+0x1c]',
    va: '0x1418c0f85',
    offset: 0x18c0585,
    source: 1024,
    target: 2048,
  },
  {
    name: 'max-user-requests-imm32',
    field: '[rax+0x18]',
    va: '0x1418c0f90',
    offset: 0x18c0590,
    source: 10,
    target: 30,
  },
];
const EMBEDDED_JSON = { offset: 0x9e5c968, length: 28210 };
const RAW_PROMPT_LENGTH = 3937;
const JSON_PROMPT_LENGTH = 4103;

export const COMPACTION_BUILDS = [
  {
    id: 'win-amd64-antigravity-2.31.2',
    version: '2.31.2',
    binarySize: 197992960,
    originalSha256: 'e40f0447109c43ece15e7025ca0864a138e0e16cb8864d4ccf64a00512a99e1a',
    offlineCandidateInputs: [],
    qualification: 'candidate',
    runtimePromptAdoption: 'unresolved',
    rawPromptLength: RAW_PROMPT_LENGTH,
    jsonPromptLength: JSON_PROMPT_LENGTH,
    embeddedJson: EMBEDDED_JSON,
    promptSegments: PROMPT_SEGMENTS,
    requestCountSites: REQUEST_COUNT_SITES,
    imm32Sites: IMM32_SITES,
    preservedPrompts: [],
  },
  {
    id: 'win-amd64-antigravity-2.32.1',
    version: '2.32.1',
    binarySize: 215547392,
    originalSha256: '65cdb8d132fc61056625081be7d07d4d22f57eba485de7edf0d24d98e77c891f',
    offlineCandidateInputs: ['65cdb8d132fc61056625081be7d07d4d22f57eba485de7edf0d24d98e77c891f'],
    qualification: 'candidate',
    runtimePromptAdoption:
      'Installed Gemini 3.8 Flash High core route verified for native/custom manual prompts and exact retention rendering; automatic compaction and other routes remain unqualified.',
    strategy: 'newest-first-total-budget-v4',
    rawPromptLength: 3937,
    embeddedJson: {
      offset: 169632252,
      length: 75817,
    },
    promptSegments: [
      {
        name: 'raw-canonical-prompt',
        role: 'prompt',
        encoding: 'raw',
        va: '0x143d76be0',
        offset: 64446944,
        length: 3937,
        preimageSha256: 'adc0b546b4512337f3edc1080cbcdf2d4b9303345664815694024e7304898a1c',
      },
    ],
    requestCountSites: [],
    imm32Sites: [],
    consumerSites: [
      {
        name: 'user-priority-allocation',
        role: 'capacity',
        va: '0x141823f75',
        offset: 25310581,
        length: 198,
        preimageSha256: '0c6bf081b49dd8c5f472158b74e6a427a2904ff84abb7d52ee0a031274fe7a99',
      },
      {
        name: 'omit-older-render-entries',
        role: 'capacity',
        va: '0x141821611',
        offset: 25299985,
        length: 214,
        preimageSha256: 'b6b808a81d21fecd0cd422870eabcf405ae3ad83c2dfe43dca6dc93b28dabef2',
      },
      {
        name: 'render-entry-dispatch',
        role: 'capacity',
        va: '0x14182160b',
        offset: 25299979,
        length: 2,
        preimageSha256: '1a7a21948de260ac5a764e0bd9843a6668a6839ab742e38cd9548f5704f76017',
      },
      {
        name: 'semantic-legacy-comparison-table',
        role: 'prompt',
        va: '0x14a1ce641',
        offset: 169661505,
        length: 4992,
        preimageSha256: '36d81d4b13c267148e7b0b746203830ec405d4518bdc1029dff2c9e2b41a9633',
      },
      {
        name: 'post-merge-outgoing-summary',
        role: 'prompt',
        va: '0x142220e89',
        offset: 35783817,
        length: 145,
        preimageSha256: '5b7de29a185645821b8348f51c74fbaa7e9cc6310b438da2754d8570bb909ca9',
      },
      {
        name: 'capture-last-30',
        role: 'capacity',
        va: '0x142222c5d',
        offset: 35791453,
        length: 15,
        preimageSha256: 'e3f8346b6f44fb6528cf5f176b50d4826e408d915ada8351d1b9ca48824da067',
      },
      {
        name: 'render-user-count-30',
        role: 'capacity',
        va: '0x141ae00e9',
        offset: 28178153,
        length: 14,
        preimageSha256: '1fb24b903f6e9136f419a466a9a79f71933c1434af5726addb646223ac028eeb',
      },
      {
        name: 'render-user-bytes-budget',
        role: 'capacity',
        va: '0x141ae0107',
        offset: 28178183,
        length: 17,
        preimageSha256: '417ea81edd075d7d540d8d86823c494a8eb4e017d6a36a04765a6c0b1f0cd935',
      },
      {
        name: 'per-user-native-utf8-ceiling',
        role: 'capacity',
        va: '0x141821411',
        offset: 25299473,
        length: 177,
        preimageSha256: '2a364ca44e1ec8b94267968eb3c97f4afabb18c0c466f984b9d68219c3f47f79',
      },
      {
        name: 'retention-loop-entry',
        role: 'capacity',
        va: '0x14182140b',
        offset: 25299467,
        length: 2,
        preimageSha256: '338a0e5cc7511540bc81683a71d8d61c44de1399a07bde43bad77d39600f2a85',
      },
      {
        name: 'core-capture-last-30',
        role: 'capacity',
        va: '0x141cc6712',
        offset: 30170386,
        length: 13,
        preimageSha256: '21f4d3bd9f50f8608c0689c21b391434c8e0a9145fc627a3f0b4d43281a12064',
      },
      {
        name: 'core-post-merge-outgoing-summary',
        role: 'prompt',
        va: '0x1420a4a4c',
        offset: 34226252,
        length: 308,
        preimageSha256: '74ddebf5435d790ca78f324ca9a805f833b852660f4f6caf623f1f4ba3d64de7',
      },
    ],
    consumerPolicy: {
      summarySelection:
        'native mode preserves every upstream prompt byte and selection; custom mode selects the exact user text on the registered Handle and core consumers',
      comparisonTable:
        'M124 outer JSON and every other embedded prompt remain byte-identical in native and custom modes',
      retentionSelection:
        'non-nil configuration captures current history using the representable int32 maximum and one fixed 61440-byte rendered-source budget; nil paths remain zero',
      perRequestSelection:
        'reverse/newest-first allocation is guarded by the full ASLR-safe FormatCheckpointUserRequests return address in the saved caller frame and always resets its budget to 61440 regardless of the incoming value; only the oldest boundary may be partial and older entries are omitted; all other callers retain incoming-budget signed water-fill',
      userRequestsReturnVa: '0x141820b05',
      parentMessagesReturnVa: '0x141820c98',
      loopExitVa: '0x141821505',
      optionsTypeVa: '0x140b69b60',
      boundsPanicVa: '0x141821fd8',
      preservedCalls:
        'Handle generateCheckpoint 0x142220f1a; formatCapturedEntries Truncate 0x1418214c2 and ToTruncatedBytesString 0x1418214c7; core generation 0x1420a4b80',
      metadata:
        'No metadata edits, new allocation calls, stack changes or external arenas. GetWaterFill preserves both LEAVE/RET PCs (0x141823f7d/3f7e and 0x141824007/4008), original makeslice calls and pcsp. Its rewritten range is UnsafePoint=-1, StackMap=1, pcsp=72 except original RET PCs=0. The renderer 0x141821611..16e7 remains pcsp=760, UnsafePoint=-1, StackMap=13. Existing Truncate/ToTruncatedBytesString and heap/write-barrier calls remain at original PCs with original pointer slots. Custom core concat remains at 0x1420a4af1 with original qualified pcsp=792, UnsafePoint=-1 and StackMap=9; RetryConfig stays in outgoing scalar slots 0x40..0x60, the source prompt is rooted at SP+0x230, and the selected result reaches original SP+0x30/0x38 before the generation call. Static metadata inspection and trusted CPU-block execution are not live qualification.',
      coreSummarySelection:
        'native mode preserves model-native selection including M432; custom mode always substitutes the user text and preserves an exact full 120-byte native manual suffix independently of the incoming prompt prefix',
      onDemandSuffix:
        'Custom mode preserves the complete native 120-byte manual suffix through runtime.concatstring2; native mode leaves the original suffix and prompt selection untouched',
      concatString2Va: '0x140070960',
      addedCallVa: '0x1420a4af1',
    },
    preservedPrompts: [
      {
        name: 'm432-native-prompt',
        profile: 'MODEL_PLACEHOLDER_M432',
        va: '0x14a1d2e30',
        offset: 169679920,
        length: 6565,
        decodedLength: 6307,
        preimageSha256: 'd31ca7e29b3c7f62e47253cb8b41cef9ed99c1973af82bde375eb812e376ba4d',
      },
    ],
    preservedBytes: [
      {
        name: 'native-on-demand-suffix',
        va: '0x143c5e70f',
        offset: 63298831,
        length: 120,
        preimageSha256: 'a908d23e988fce4ccd7352103d855d43531fe9a7225f65ac6b00a63db8b368fd',
      },
    ],
    historicalRecipes: [
      {
        input: 'original',
        inputSha256: '65cdb8d132fc61056625081be7d07d4d22f57eba485de7edf0d24d98e77c891f',
        outputSha256: 'b9ba32e6e1f23227e2ac1f109e509b8e487d231397002e24a44cac1c556997da',
        fingerprint: 'dcc5c351fcf209d0d87a9ca2cb2d43aca1994e4265882c45fa274b36ae75d499',
      },
      {
        input: 'original',
        inputSha256: '65cdb8d132fc61056625081be7d07d4d22f57eba485de7edf0d24d98e77c891f',
        outputSha256: '1128a0cb82de55743875cb1921565887dbc07686a934805f1caee0e81bf87cee',
        fingerprint: '1b201f436605748b6ae741682e8922bb0746f7582ff6472030800c5396f0f359',
      },
      {
        input: 'original',
        inputSha256: '65cdb8d132fc61056625081be7d07d4d22f57eba485de7edf0d24d98e77c891f',
        outputSha256: '26bd44bef0d26bdf40c05aec9cb1decdee0eb476eccc2720968560abc153ecb9',
        fingerprint: 'edce28dc43923c50e8627e97731d07c72e7c1d34bdafbe9796e4b58715225995',
      },
    ],
  },
];
