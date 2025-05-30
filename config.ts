import Conf from "conf";
import type { Schema } from "conf";

export type Currency = "USD" | "JPY";

interface ConfigSchema {
	currency: Currency;
}

const schema: Schema<ConfigSchema> = {
	currency: {
		type: "string",
		enum: ["USD", "JPY"],
		default: "USD",
	},
};

const config = new Conf<ConfigSchema>({
	projectName: "ccusage",
	schema,
	defaults: {
		currency: "USD",
	},
});

export function getCurrency(): Currency {
	return config.get("currency");
}

export function setCurrency(currency: Currency): void {
	if (!["USD", "JPY"].includes(currency)) {
		throw new Error(`Invalid currency: ${currency}. Must be USD or JPY.`);
	}
	config.set("currency", currency);
}

export function getConfigPath(): string {
	return config.path;
}
