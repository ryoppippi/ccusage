import * as v from "valibot";
import { dateSchema } from "./types";

export const parseDateArg = (value: string): string => {
	const result = v.safeParse(dateSchema, value);
	if (!result.success) {
		throw new TypeError(result.issues[0].message);
	}
	return result.output;
};
