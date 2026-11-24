// The decoding rules ACP's schema attaches to fields with `x-deserialize-*`
// markers, as the reference SDK applies them with serde_with. The generated
// schemas call these; decoding is lenient where the spec says so, while
// `Schema.is` and encoding stay strict.
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SchemaParser from "effect/SchemaParser";
import * as SchemaTransformation from "effect/SchemaTransformation";

/**
 * `x-deserialize-default-on-error`: a value that fails to decode does not fail
 * the message around it. Without `fallback` the key is dropped, as if the peer
 * had omitted it; a missing required key still fails.
 */
export const defaultOnError = <S extends Schema.Top>(schema: S, fallback?: () => S["Type"]) =>
  schema.pipe(
    Schema.catchDecoding(() =>
      Effect.succeed(fallback === undefined ? Option.none() : Option.some(fallback())),
    ),
  );

/**
 * A union over both protocol generations' schemas for one message. The client
 * tells the generations apart by which schema rejects a message, and lenient
 * decoding would let one generation's schema take the other's message by
 * dropping the fields that differ. So every member is tried strictly first.
 */
export const strictFirstUnion = <const Members extends ReadonlyArray<Schema.Top>>(
  members: Members,
): Schema.Union<Members> =>
  Schema.Union([
    ...members.map((member) => Schema.toType(member)),
    ...members,
  ]) as unknown as Schema.Union<Members>;

/** `x-deserialize-skip-invalid-items`: list items that fail to decode are left out. */
export const skipInvalidItems = <S extends Schema.Top>(item: S) => {
  const decodeItem = SchemaParser.decodeUnknownEffect(item);
  const encodeItem = SchemaParser.encodeUnknownEffect(item);
  // Each item is decoded on its own below, so the list only has to be an array.
  const items = Schema.declare(
    (input): input is ReadonlyArray<S["Encoded"]> => Array.isArray(input),
    { expected: "array" },
  );
  return items.pipe(
    Schema.decodeTo(
      Schema.Array(Schema.toType(item)),
      SchemaTransformation.transformEffect<
        ReadonlyArray<S["Type"]>,
        ReadonlyArray<S["Encoded"]>,
        S["DecodingServices"],
        S["EncodingServices"]
      >({
        decode: (values, options) =>
          Effect.map(
            Effect.forEach(values, (value) => Effect.option(decodeItem(value, options))),
            Arr.getSomes,
          ),
        encode: (values, options) => Effect.forEach(values, (value) => encodeItem(value, options)),
      }),
    ),
  );
};
