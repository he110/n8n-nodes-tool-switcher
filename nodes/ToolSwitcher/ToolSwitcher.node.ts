import {
	NodeConnectionTypes,
	type INodeType,
	type INodeTypeDescription,
	type ISupplyDataFunctions,
	type IExecuteFunctions,
	type INodeExecutionData,
	type SupplyData,
	type ILoadOptionsFunctions,
	NodeOperationError,
} from 'n8n-workflow';

import { numberInputsProperty, configuredInputs } from './helpers';

interface LangChainTool {
	name: string;
	description: string;
	schema: unknown;
	invoke(input: unknown): Promise<unknown>;
}

interface ToolSelectionRule {
	toolIndex: number;
	conditions: {
		options: {
			caseSensitive: boolean;
			typeValidation: 'strict' | 'loose';
			leftValue: string;
			version: 1 | 2;
		};
		conditions: Array<{
			id: string;
			leftValue: string;
			rightValue: string;
			operator: {
				type: string;
				operation: string;
				name: string;
			};
		}>;
		combinator: 'and' | 'or';
	};
}

/**
 * Extracts individual tools from a response object.
 * A response can be a Toolkit (with getTools()), an array, or a single tool.
 */
function extractTools(response: unknown): LangChainTool[] {
	if (response == null) return [];
	if (Array.isArray(response)) return response as LangChainTool[];
	if (typeof response === 'object' &&
		'getTools' in (response as Record<string, unknown>) &&
		typeof (response as Record<string, unknown>).getTools === 'function') {
		return (response as { getTools(): LangChainTool[] }).getTools();
	}
	return [response as LangChainTool];
}

/**
 * Creates proxy DynamicStructuredTool wrappers around original tools.
 *
 * Each wrapper has the same name, description, and schema as the original,
 * but its `func` calls `.invoke()` on the original tool directly.
 * This avoids n8n trying to execute ToolSwitcher as a routing node
 * when the agent invokes a tool.
 *
 * When only one tool is selected, it is returned as-is (no wrapping needed
 * since n8n routes the call to the original node).
 */
function wrapToolsResponse(selectedResponses: unknown[]): unknown {
	const allOriginalTools: LangChainTool[] = [];
	for (const response of selectedResponses) {
		allOriginalTools.push(...extractTools(response));
	}

	if (allOriginalTools.length === 0) {
		return selectedResponses[0];
	}

	if (allOriginalTools.length === 1) {
		return allOriginalTools[0];
	}

	// Create DynamicStructuredTool proxies that delegate .invoke() to the originals
	const { DynamicStructuredTool } = require('@langchain/core/tools') as {
		DynamicStructuredTool: new (config: {
			name: string;
			description: string;
			schema: unknown;
			func: (input: Record<string, unknown>) => Promise<string>;
		}) => unknown;
	};

	const { BaseToolkit } = require('@langchain/core/tools') as {
		BaseToolkit: new () => { tools: unknown[] };
	};

	const proxyTools = allOriginalTools.map((original) =>
		new DynamicStructuredTool({
			name: original.name,
			description: original.description,
			schema: original.schema,
			func: async (input: Record<string, unknown>) => {
				const result = await original.invoke(input);
				return typeof result === 'string' ? result : JSON.stringify(result);
			},
		}),
	);

	const toolkit = new BaseToolkit();
	toolkit.tools = proxyTools;
	return toolkit;
}

// Static store: maps "executionId:nodeName" -> selected tools
// Populated by supplyData(), consumed by execute()
const toolsStore = new Map<string, LangChainTool[]>();

function storeKey(executionId: string, nodeName: string): string {
	return `${executionId}:${nodeName}`;
}

export class ToolSwitcher implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Tool Switcher',
		name: 'toolSwitcher',
		icon: 'file:tool-switcher.svg',
		defaults: {
			name: 'Tool Switcher',
		},
		version: 1,
		group: ['transform'],
		description:
			'Dynamically select which AI tools to provide to an Agent based on configurable rules',
		inputs: `={{
				((parameters) => {
					${configuredInputs.toString()};
					return configuredInputs(parameters)
				})($parameter)
			}}`,
		codex: {
			categories: ['AI'],
			subcategories: {
				AI: ['Tools'],
				Tools: ['Other Tools'],
			},
			resources: {},
		},
		outputs: [NodeConnectionTypes.AiTool],
		outputNames: ['Tools'],
		requiredInputs: 1,
		properties: [
			numberInputsProperty,
			{
				displayName: 'Rules',
				name: 'rules',
				placeholder: 'Add Rule',
				type: 'fixedCollection',
				typeOptions: {
					multipleValues: true,
					sortable: true,
				},
				description: 'Rules to determine which tools are provided to the Agent. All tools whose conditions are met will be included.',
				default: {},
				options: [
					{
						displayName: 'Rule',
						name: 'rule',
						values: [
							{
								displayName: 'Tool',
								name: 'toolIndex',
								type: 'options',
								description: 'Choose tool input from the list',
								default: 1,
								required: true,
								placeholder: 'Choose tool input from the list',
								typeOptions: {
									loadOptionsMethod: 'getTools',
								},
							},
							{
								displayName: 'Conditions',
								name: 'conditions',
								placeholder: 'Add Condition',
								type: 'filter',
								default: {},
								typeOptions: {
									filter: {
										caseSensitive: true,
										typeValidation: 'strict',
										version: 2,
									},
								},
								description: 'Conditions that must be met to include this tool',
							},
						],
					},
				],
			},
		],
	};

	methods = {
		loadOptions: {
			async getTools(this: ILoadOptionsFunctions) {
				const numberInputs = this.getCurrentNodeParameter('numberInputs') as number;

				return Array.from({ length: numberInputs ?? 2 }, (_, i) => ({
					value: i + 1,
					name: `Tool ${(i + 1).toString()}`,
				}));
			},
		},
	};

	/**
	 * execute() is called by n8n when the agent invokes a tool that was provided
	 * by this node. n8n passes tool arguments as AiTool input data.
	 * We retrieve the tool name from the input and delegate to the matching
	 * original tool's invoke().
	 */
	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const toolArgs = items[0]?.json ?? {};

		// n8n stores the tool info in AiTool input when isFromToolkit=true
		// The tool name comes in items[0].json.tool.name
		const toolMeta = (toolArgs as Record<string, unknown>).tool;
		const requestedToolName = toolMeta && typeof toolMeta === 'object'
			? (toolMeta as { name?: string }).name
			: (typeof toolMeta === 'string' ? toolMeta : undefined);

		// Retrieve stored tools using static store keyed by executionId:nodeName
		const executionId = this.getExecutionId();
		const nodeName = this.getNode().name;
		const key = storeKey(executionId, nodeName);
		const allTools = toolsStore.get(key) ?? [];

		if (allTools.length === 0) {
			return [[{ json: { response: 'Error: No tools available' } }]];
		}

		// Find the tool by name if available
		let targetTool: LangChainTool | undefined;
		if (requestedToolName) {
			targetTool = allTools.find((t) => t.name === requestedToolName);
		}

		// Fallback: if only one tool, use it
		if (!targetTool && allTools.length === 1) {
			targetTool = allTools[0];
		}

		if (!targetTool) {
			const availableNames = allTools.map((t) => t.name).join(', ');
			return [[{ json: { response: `Error: Tool "${requestedToolName ?? 'unknown'}" not found. Available: ${availableNames}` } }]];
		}

		try {
			const result = await targetTool.invoke(toolArgs);
			const response = typeof result === 'string' ? result : JSON.stringify(result);
			return [[{ json: { response } }]];
		} catch (error) {
			const errMsg = error instanceof Error ? error.message : String(error);
			return [[{ json: { response: `Error calling tool "${targetTool.name}": ${errMsg}` } }]];
		}
	}

	async supplyData(this: ISupplyDataFunctions, itemIndex: number): Promise<SupplyData> {
		const numberInputs = this.getNodeParameter('numberInputs', itemIndex, 2) as number;

		// getInputConnectionData returns all connected tool responses as a flat array
		// (one entry per connected node, in the order returned by getConnectedNodes).
		// We need to map them back to the correct input slots.
		const allToolData = (await this.getInputConnectionData(
			NodeConnectionTypes.AiTool,
			itemIndex,
		)) as unknown;

		if (allToolData == null || (Array.isArray(allToolData) && allToolData.length === 0)) {
			throw new NodeOperationError(this.getNode(), 'No tools connected', {
				itemIndex,
				description: 'Connect at least one tool to the Tool Switcher inputs',
			});
		}

		// Access the internal workflow connections to map node names to slot indices.
		// n8n's SupplyDataContext has getConnections(node, type) at runtime which returns
		// connectionsByDestinationNode[node.name][type] — an array of arrays indexed by slot.
		const thisNode = this.getNode();
		const context = this as unknown as {
			getConnections(node: { name: string }, type: string): Array<Array<{ node: string }>> | undefined;
			getConnectedNodes(type: string): Array<{ name: string; disabled?: boolean }>;
		};

		let connections: Array<Array<{ node: string }>> = [];
		try {
			connections = context.getConnections(thisNode, NodeConnectionTypes.AiTool) ?? [];
		} catch {
			// Fallback if getConnections is not available
		}

		// Build: node name -> slot index (1-based, matching toolIndex in rules)
		const nodeToSlot = new Map<string, number>();
		for (let slotIdx = 0; slotIdx < connections.length; slotIdx++) {
			const slotConns = connections[slotIdx];
			if (slotConns) {
				for (const conn of slotConns) {
					if (conn.node && !nodeToSlot.has(conn.node)) {
						nodeToSlot.set(conn.node, slotIdx + 1);
					}
				}
			}
		}

		// getConnectedNodes (used internally by getInputConnectionData) returns nodes
		// by iterating slots with forEach and using unshift — producing reverse slot order.
		// Replicate that order to match responseArray indices.
		let connectedNodeNames: string[] = [];
		try {
			const nodes = context.getConnectedNodes(NodeConnectionTypes.AiTool);
			connectedNodeNames = nodes.map((n) => n.name);
		} catch {
			// Fallback: reconstruct the order manually (unshift = reverse slot order)
			const seen = new Set<string>();
			for (const slotConns of connections) {
				if (slotConns) {
					for (const conn of slotConns) {
						if (conn.node && !seen.has(conn.node)) {
							connectedNodeNames.unshift(conn.node);
							seen.add(conn.node);
						}
					}
				}
			}
		}

		// Map each response to its slot (keep original response objects intact)
		const slotResponses: Array<unknown | null> = Array.from({ length: numberInputs }, () => null);
		const responseArray = Array.isArray(allToolData) ? allToolData : [allToolData];

		for (let i = 0; i < responseArray.length && i < connectedNodeNames.length; i++) {
			const connNodeName = connectedNodeNames[i];
			if (nodeToSlot.has(connNodeName)) {
				const slotIdx = nodeToSlot.get(connNodeName)!;
				if (slotIdx >= 1 && slotIdx <= numberInputs) {
					slotResponses[slotIdx - 1] = responseArray[i];
				}
			}
		}

		const rules = this.getNodeParameter('rules.rule', itemIndex, []) as ToolSelectionRule[];

		if (!rules || rules.length === 0) {
			throw new NodeOperationError(this.getNode(), 'No rules defined', {
				itemIndex,
				description: 'At least one rule must be defined to select tools',
			});
		}

		// Collect original response objects for slots where conditions are met
		const selectedResponses: unknown[] = [];
		const selectedSlots = new Set<number>();

		for (let i = 0; i < rules.length; i++) {
			const rule = rules[i];
			const toolIndex = rule.toolIndex;

			if (toolIndex <= 0 || toolIndex > numberInputs) {
				throw new NodeOperationError(this.getNode(), `Invalid tool index ${toolIndex}`, {
					itemIndex,
					description: `Tool index must be between 1 and ${numberInputs}`,
				});
			}

			const conditionsMet = this.getNodeParameter(`rules.rule[${i}].conditions`, itemIndex, false, {
				extractValue: true,
			}) as boolean;

			if (conditionsMet && !selectedSlots.has(toolIndex)) {
				selectedSlots.add(toolIndex);
				const response = slotResponses[toolIndex - 1];
				if (response != null) {
					selectedResponses.push(response);
				}
			}
		}

		// Store all tools in static store so execute() can access them
		const allOriginalTools: LangChainTool[] = [];
		for (const response of selectedResponses) {
			allOriginalTools.push(...extractTools(response));
		}
		const executionId = (this as unknown as { getExecutionId(): string }).getExecutionId();
		const nodeName = this.getNode().name;
		toolsStore.set(storeKey(executionId, nodeName), allOriginalTools);

		return {
			response: wrapToolsResponse(selectedResponses),
		};
	}
}
