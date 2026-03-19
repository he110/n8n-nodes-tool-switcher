import {
	NodeConnectionTypes,
	type INodeType,
	type INodeTypeDescription,
	type ISupplyDataFunctions,
	type SupplyData,
	type ILoadOptionsFunctions,
	NodeOperationError,
} from 'n8n-workflow';

import { numberInputsProperty, configuredInputs } from './helpers';

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

	async supplyData(this: ISupplyDataFunctions, itemIndex: number): Promise<SupplyData> {
		const tools = (await this.getInputConnectionData(
			NodeConnectionTypes.AiTool,
			itemIndex,
		)) as unknown[];

		if (!tools || tools.length === 0) {
			throw new NodeOperationError(this.getNode(), 'No tools connected', {
				itemIndex,
				description: 'Connect at least one tool to the Tool Switcher inputs',
			});
		}
		tools.reverse();

		const rules = this.getNodeParameter('rules.rule', itemIndex, []) as ToolSelectionRule[];

		if (!rules || rules.length === 0) {
			throw new NodeOperationError(this.getNode(), 'No rules defined', {
				itemIndex,
				description: 'At least one rule must be defined to select tools',
			});
		}

		const selectedTools: unknown[] = [];

		for (let i = 0; i < rules.length; i++) {
			const rule = rules[i];
			const toolIndex = rule.toolIndex;

			if (toolIndex <= 0 || toolIndex > tools.length) {
				throw new NodeOperationError(this.getNode(), `Invalid tool index ${toolIndex}`, {
					itemIndex,
					description: `Tool index must be between 1 and ${tools.length}`,
				});
			}

			const conditionsMet = this.getNodeParameter(`rules.rule[${i}].conditions`, itemIndex, false, {
				extractValue: true,
			}) as boolean;

			if (conditionsMet) {
				const tool = tools[toolIndex - 1];
				if (!selectedTools.includes(tool)) {
					selectedTools.push(tool);
				}
			}
		}

		return {
			response: selectedTools,
		};
	}
}
