import * as v from 'valibot';

const isoTimestampRegex = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:Z|[+-]\d{2}:\d{2})$/;
export const isoTimestampSchema = v.pipe(
	v.string(),
	v.regex(isoTimestampRegex, 'Invalid ISO timestamp'),
	v.brand('ISOTimestamp'),
);

export type ISOTimestamp = v.InferOutput<typeof isoTimestampSchema>;
