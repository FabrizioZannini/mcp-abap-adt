#!/usr/bin/env node
import {
  McpServer,
  fromJsonSchema,
  type CallToolResult,
} from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import path from "path";
import dotenv from "dotenv";

// Import handler functions
import { handleGetProgram } from "./handlers/handleGetProgram";
import { handleGetClass } from "./handlers/handleGetClass";
import { handleGetFunctionGroup } from "./handlers/handleGetFunctionGroup";
import { handleGetFunction } from "./handlers/handleGetFunction";
import { handleGetTable } from "./handlers/handleGetTable";
import { handleGetStructure } from "./handlers/handleGetStructure";
import { handleGetTableContents } from "./handlers/handleGetTableContents";
import { handleGetPackage } from "./handlers/handleGetPackage";
import { handleGetInclude } from "./handlers/handleGetInclude";
import { handleGetTypeInfo } from "./handlers/handleGetTypeInfo";
import { handleGetInterface } from "./handlers/handleGetInterface";
import { handleGetTransaction } from "./handlers/handleGetTransaction";
import { handleSearchObject } from "./handlers/handleSearchObject";
import { handleGetCDSView } from "./handlers/handleGetCDSView";
import { handleGetBehaviorDefinition } from "./handlers/handleGetBehaviorDefinition";
import { handleGetServiceDefinition } from "./handlers/handleGetServiceDefinition";
import { handleCreateProgram } from "./handlers/handleCreateProgram";
import { handleUpdateProgramSource } from "./handlers/handleUpdateProgramSource";
import { handleActivateObject } from "./handlers/handleActivateObject";
import { handleGetTransportInfo } from "./handlers/handleGetTransportInfo";
import {
  handleGetTextElements,
  handleUpdateTextElements,
} from "./handlers/handleTextElements";
import { isWriteEnabled } from "./lib/adtWrite";

// Import shared utility functions and types
import { MAX_PAGE_LINES, cleanup } from "./lib/utils";
import { withRequestSignal } from "./lib/network";

export { getConfig } from "./config";
export type { SapConfig } from "./config";

// Load environment variables from .env file
dotenv.config({ path: path.resolve(__dirname, "../.env") });

// Shared schema fragments for every tool whose textual result is protected by
// the response byte cap. Runtime validation in lib/utils.ts matches these bounds.
export const PAGING_START_LINE = {
  type: "integer",
  minimum: 1,
  description:
    "1-based line number to start from (default 1). Beyond EOF returns an empty page with hasMore=false.",
};
export const PAGING_MAX_LINES = {
  type: "integer",
  minimum: 1,
  maximum: MAX_PAGE_LINES,
  description: `Maximum lines to return (1-${MAX_PAGE_LINES}). Omit to request the rest; the byte cap may return fewer lines.`,
};

export const PAGED_TEXT_TOOL_NAMES = [
  "GetProgram",
  "GetClass",
  "GetFunctionGroup",
  "GetFunction",
  "GetStructure",
  "GetTable",
  "GetTableContents",
  "GetPackage",
  "GetTypeInfo",
  "GetInclude",
  "SearchObject",
  "GetTransaction",
  "GetCDSView",
  "GetInterface",
  "GetBehaviorDefinition",
  "GetServiceDefinition",
] as const;

const PAGED_TEXT_TOOL_SET = new Set<string>(PAGED_TEXT_TOOL_NAMES);

export function addPagingSchemas(tools: any[]) {
  return tools.map((tool) => {
    if (!PAGED_TEXT_TOOL_SET.has(tool.name)) {
      return tool;
    }
    return {
      ...tool,
      inputSchema: {
        ...tool.inputSchema,
        properties: {
          ...tool.inputSchema.properties,
          startLine: PAGING_START_LINE,
          maxLines: PAGING_MAX_LINES,
        },
      },
    };
  });
}

const TOOL_DEFINITIONS = [
  // Define available tools
  {
    name: "GetProgram",
    description:
      "Retrieve ABAP program source code. For large programs, use startLine/maxLines to page through the source instead of retrieving it all at once.",
    inputSchema: {
      type: "object",
      properties: {
        program_name: {
          type: "string",
          description: "Name of the ABAP program",
        },
        startLine: PAGING_START_LINE,
        maxLines: PAGING_MAX_LINES,
      },
      required: ["program_name"],
    },
  },
  {
    name: "GetClass",
    description:
      "Retrieve ABAP class source code. For large classes, use startLine/maxLines to page through the source instead of retrieving it all at once.",
    inputSchema: {
      type: "object",
      properties: {
        class_name: {
          type: "string",
          description: "Name of the ABAP class",
        },
        startLine: PAGING_START_LINE,
        maxLines: PAGING_MAX_LINES,
      },
      required: ["class_name"],
    },
  },
  {
    name: "GetFunctionGroup",
    description:
      "Retrieve ABAP Function Group source code. For large function groups, use startLine/maxLines to page through the source instead of retrieving it all at once.",
    inputSchema: {
      type: "object",
      properties: {
        function_group: {
          type: "string",
          description: "Name of the function module",
        },
        startLine: PAGING_START_LINE,
        maxLines: PAGING_MAX_LINES,
      },
      required: ["function_group"],
    },
  },
  {
    name: "GetFunction",
    description:
      "Retrieve ABAP Function Module source code. For large function modules, use startLine/maxLines to page through the source instead of retrieving it all at once.",
    inputSchema: {
      type: "object",
      properties: {
        function_name: {
          type: "string",
          description: "Name of the function module",
        },
        function_group: {
          type: "string",
          description: "Name of the function group",
        },
        startLine: PAGING_START_LINE,
        maxLines: PAGING_MAX_LINES,
      },
      required: ["function_name", "function_group"],
    },
  },
  {
    name: "GetStructure",
    description:
      "Retrieve ABAP Structure. For large structures, use startLine/maxLines to page through the result instead of retrieving it all at once.",
    inputSchema: {
      type: "object",
      properties: {
        structure_name: {
          type: "string",
          description: "Name of the ABAP Structure",
        },
        startLine: PAGING_START_LINE,
        maxLines: PAGING_MAX_LINES,
      },
      required: ["structure_name"],
    },
  },
  {
    name: "GetTable",
    description:
      "Retrieve ABAP table structure. For large tables, use startLine/maxLines to page through the result instead of retrieving it all at once.",
    inputSchema: {
      type: "object",
      properties: {
        table_name: {
          type: "string",
          description: "Name of the ABAP table",
        },
        startLine: PAGING_START_LINE,
        maxLines: PAGING_MAX_LINES,
      },
      required: ["table_name"],
    },
  },
  {
    name: "GetTableContents",
    description:
      "Retrieve contents of an ABAP table. max_rows limits SAP rows; startLine/maxLines page the returned textual XML when its serialized size is still large.",
    inputSchema: {
      type: "object",
      properties: {
        table_name: {
          type: "string",
          description: "Name of the ABAP table",
        },
        max_rows: {
          type: "number",
          description: "Maximum number of rows to retrieve",
          default: 100,
        },
      },
      required: ["table_name"],
    },
  },
  {
    name: "GetPackage",
    description:
      "Retrieve ABAP package details. Use startLine/maxLines to page large serialized package listings.",
    inputSchema: {
      type: "object",
      properties: {
        package_name: {
          type: "string",
          description: "Name of the ABAP package",
        },
      },
      required: ["package_name"],
    },
  },
  {
    name: "GetTypeInfo",
    description:
      "Retrieve ABAP type information. For large results, use startLine/maxLines to page through it instead of retrieving it all at once.",
    inputSchema: {
      type: "object",
      properties: {
        type_name: {
          type: "string",
          description: "Name of the ABAP type",
        },
        startLine: PAGING_START_LINE,
        maxLines: PAGING_MAX_LINES,
      },
      required: ["type_name"],
    },
  },
  {
    name: "GetInclude",
    description:
      "Retrieve ABAP Include Source Code. For large includes, use startLine/maxLines to page through the source instead of retrieving it all at once.",
    inputSchema: {
      type: "object",
      properties: {
        include_name: {
          type: "string",
          description: "Name of the ABAP Include",
        },
        startLine: PAGING_START_LINE,
        maxLines: PAGING_MAX_LINES,
      },
      required: ["include_name"],
    },
  },
  {
    name: "SearchObject",
    description:
      "Search for ABAP objects using quick search. maxResults limits matches; startLine/maxLines page the returned textual XML when its serialized size is still large.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query string (use * wildcard for partial match)",
        },
        maxResults: {
          type: "number",
          description: "Maximum number of results to return",
          default: 100,
        },
      },
      required: ["query"],
    },
  },
  {
    name: "GetTransaction",
    description:
      "Retrieve ABAP transaction details. For large results, use startLine/maxLines to page through it instead of retrieving it all at once.",
    inputSchema: {
      type: "object",
      properties: {
        transaction_name: {
          type: "string",
          description: "Name of the ABAP transaction",
        },
        startLine: PAGING_START_LINE,
        maxLines: PAGING_MAX_LINES,
      },
      required: ["transaction_name"],
    },
  },
  {
    name: "GetCDSView",
    description:
      "Retrieve CDS view (DDL source) source code. For large views, use startLine/maxLines to page through the source instead of retrieving it all at once.",
    inputSchema: {
      type: "object",
      properties: {
        cds_view_name: {
          type: "string",
          description:
            "Name of the CDS view (DDL source name, e.g. I_CURRENCY)",
        },
        startLine: PAGING_START_LINE,
        maxLines: PAGING_MAX_LINES,
      },
      required: ["cds_view_name"],
    },
  },
  {
    name: "GetInterface",
    description:
      "Retrieve ABAP interface source code. For large interfaces, use startLine/maxLines to page through the source instead of retrieving it all at once.",
    inputSchema: {
      type: "object",
      properties: {
        interface_name: {
          type: "string",
          description: "Name of the ABAP interface",
        },
        startLine: PAGING_START_LINE,
        maxLines: PAGING_MAX_LINES,
      },
      required: ["interface_name"],
    },
  },
  {
    name: "GetBehaviorDefinition",
    description:
      "Retrieve RAP Behavior Definition (BDEF) source code (requires ~NW 7.54 / S/4HANA). For large definitions, use startLine/maxLines to page through the source instead of retrieving it all at once.",
    inputSchema: {
      type: "object",
      properties: {
        behavior_definition_name: {
          type: "string",
          description: "Name of the RAP Behavior Definition (e.g. I_MY_ENTITY)",
        },
        startLine: PAGING_START_LINE,
        maxLines: PAGING_MAX_LINES,
      },
      required: ["behavior_definition_name"],
    },
  },
  {
    name: "GetServiceDefinition",
    description:
      "Retrieve RAP Service Definition (SRVD) source code (requires ~NW 7.54 / S/4HANA). For large definitions, use startLine/maxLines to page through the source instead of retrieving it all at once.",
    inputSchema: {
      type: "object",
      properties: {
        service_definition_name: {
          type: "string",
          description: "Name of the RAP Service Definition (e.g. Z_MY_SERVICE)",
        },
        startLine: PAGING_START_LINE,
        maxLines: PAGING_MAX_LINES,
      },
      required: ["service_definition_name"],
    },
  },
];

// Write tools: registered only when SAP_ALLOW_WRITE=1. They are limited to
// customer objects (Y*, Z*, /NAMESPACE/) and always release their locks.
const TEXT_KIND = {
  type: "string",
  enum: ["symbols", "selections", "headings"],
  description:
    "symbols = text symbols (TEXT-xxx), selections = selection texts, headings = list headings",
};
const TRANSPORT = {
  type: "string",
  description:
    "Transport request number (e.g. MEDK900123). Required for transportable packages.",
};

export const WRITE_TOOL_DEFINITIONS = [
  {
    name: "GetTransportInfo",
    readOnly: true,
    description:
      "Ask the Transport Organizer which transport requests can record a program in a package. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        package_name: { type: "string", description: "Target package" },
        program_name: { type: "string", description: "Program name" },
      },
      required: ["package_name", "program_name"],
    },
  },
  {
    name: "GetTextElements",
    readOnly: true,
    description:
      "Read text symbols, selection texts or list headings of an ABAP program. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        program_name: { type: "string", description: "Program name" },
        kind: TEXT_KIND,
      },
      required: ["program_name", "kind"],
    },
  },
  {
    name: "CreateProgram",
    description:
      "Create a new executable ABAP program (Y*/Z* only) in a package, recorded on a transport request. Creates an empty program; write it with UpdateProgramSource.",
    inputSchema: {
      type: "object",
      properties: {
        program_name: { type: "string", description: "New program name" },
        description: {
          type: "string",
          description: "Program title (max 70 characters)",
        },
        package_name: {
          type: "string",
          description: "Package ($TMP for a local object)",
        },
        transport: TRANSPORT,
        language: {
          type: "string",
          description:
            "Master language (two letters, default SAP_LANGUAGE or EN)",
        },
      },
      required: ["program_name", "description", "package_name"],
    },
  },
  {
    name: "UpdateProgramSource",
    description:
      "Replace the full source of an ABAP program (Y*/Z* only): lock, write, unlock. The new version stays inactive until ActivateObject.",
    inputSchema: {
      type: "object",
      properties: {
        program_name: { type: "string", description: "Program name" },
        source: { type: "string", description: "Complete ABAP source" },
        transport: TRANSPORT,
      },
      required: ["program_name", "source"],
    },
  },
  {
    name: "UpdateTextElements",
    description:
      "Replace text symbols, selection texts or list headings of an ABAP program (Y*/Z* only). Use GetTextElements first to see the expected format.",
    inputSchema: {
      type: "object",
      properties: {
        program_name: { type: "string", description: "Program name" },
        kind: TEXT_KIND,
        source: {
          type: "string",
          description: "Complete text elements content in ADT text format",
        },
        transport: TRANSPORT,
      },
      required: ["program_name", "kind", "source"],
    },
  },
  {
    name: "ActivateObject",
    description:
      "Activate an ABAP object (Y*/Z* only) and return the activation messages (errors with line numbers).",
    inputSchema: {
      type: "object",
      properties: {
        object_name: { type: "string", description: "Object name" },
        object_type: {
          type: "string",
          enum: ["PROG", "INCL", "CLAS", "INTF"],
          description: "Object type (default PROG)",
        },
      },
      required: ["object_name"],
    },
  },
];

const WRITE_HANDLERS: Record<string, (args: any) => Promise<any>> = {
  GetTransportInfo: handleGetTransportInfo,
  GetTextElements: handleGetTextElements,
  CreateProgram: handleCreateProgram,
  UpdateProgramSource: handleUpdateProgramSource,
  UpdateTextElements: handleUpdateTextElements,
  ActivateObject: handleActivateObject,
};

const HANDLERS: Record<string, (args: any) => Promise<any>> = {
  GetProgram: handleGetProgram,
  GetClass: handleGetClass,
  GetFunction: handleGetFunction,
  GetFunctionGroup: handleGetFunctionGroup,
  GetStructure: handleGetStructure,
  GetTable: handleGetTable,
  GetTableContents: handleGetTableContents,
  GetPackage: handleGetPackage,
  GetTypeInfo: handleGetTypeInfo,
  GetInclude: handleGetInclude,
  SearchObject: handleSearchObject,
  GetInterface: handleGetInterface,
  GetTransaction: handleGetTransaction,
  GetCDSView: handleGetCDSView,
  GetBehaviorDefinition: handleGetBehaviorDefinition,
  GetServiceDefinition: handleGetServiceDefinition,
};

export function createServer(): McpServer {
  const server = new McpServer({
    name: "mcp-abap-adt",
    version: require("../package.json").version,
  });
  for (const tool of addPagingSchemas(TOOL_DEFINITIONS)) {
    const properties = tool.inputSchema.properties;
    for (const value of Object.values(properties) as any[]) {
      if (value.type === "string") {
        value.minLength = 1;
        value.maxLength = 1024;
      }
    }
    for (const name of ["max_rows", "maxResults"]) {
      if (properties[name])
        Object.assign(properties[name], {
          type: "integer",
          minimum: 1,
          maximum: 10000,
        });
    }
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: fromJsonSchema<Record<string, unknown>>({
          ...tool.inputSchema,
          additionalProperties: false,
        }),
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      async (args, ctx) =>
        withRequestSignal(
          ctx.mcpReq.signal,
          async () => (await HANDLERS[tool.name](args)) as CallToolResult,
        ),
    );
  }
  if (isWriteEnabled()) {
    for (const tool of WRITE_TOOL_DEFINITIONS) {
      const properties: Record<string, any> = structuredClone(
        tool.inputSchema.properties,
      );
      for (const [name, value] of Object.entries(properties)) {
        if (value.type === "string" && !value.enum) {
          value.minLength = 1;
          value.maxLength = name === "source" ? 2 * 1024 * 1024 : 1024;
        }
      }
      server.registerTool(
        tool.name,
        {
          description: tool.description,
          inputSchema: fromJsonSchema<Record<string, unknown>>({
            ...tool.inputSchema,
            properties,
            additionalProperties: false,
          }),
          annotations: tool.readOnly
            ? {
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: true,
              }
            : {
                readOnlyHint: false,
                destructiveHint: tool.name !== "CreateProgram",
                idempotentHint: false,
                openWorldHint: true,
              },
        },
        async (args, ctx) =>
          withRequestSignal(
            ctx.mcpReq.signal,
            async () =>
              (await WRITE_HANDLERS[tool.name](args)) as CallToolResult,
          ),
      );
    }
  }
  return server;
}

export class mcp_abap_adt_server {
  async run() {
    const handle = serveStdio(() => createServer());
    const stop = async () => {
      await handle.close();
      cleanup();
    };
    process.once("SIGINT", () => {
      void stop();
    });
    process.once("SIGTERM", () => {
      void stop();
    });
    process.stdin.once("end", cleanup);
  }
}

if (require.main === module) {
  new mcp_abap_adt_server().run().catch(() => {
    console.error("Unable to start mcp-abap-adt");
    process.exitCode = 1;
  });
}
