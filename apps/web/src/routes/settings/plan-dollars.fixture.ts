// What a plan holds stays private (docs/ section 9). A plan surface, as it renders, may say dollars only for a
// plan's price, its "up to $X of usage" headline, a plan's name ("Pro $60") and money that is the person's own
// (credits, pay as you go). `planDollars` returns every other "$" followed by digits, so a test fails on the first one.

const text = (markup: string) =>
  markup
    .replace(/<[^>]*>/g, " ")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ");

/**
 * The dollars a plan surface may say. A price ends at its period and is never what a plan "holds": "$20 a month, at
 * list price" and "holds $105 a month" are allowances, so the comma and the verb keep them from passing as prices.
 */
const ALLOWED: ReadonlyArray<RegExp> = [
  /[Uu]p to \$[\d,]+ of usage/g,
  /\b(?:Pro|Max) \$\d+/g,
  /(?<!holds )\$[\d,.]+ (?:a|\/) (?:month|year)(?![,\w])/g,
  /\$[\d,]+ billed yearly/g,
  /\$0 forever/g,
];

/** What used to say what a plan holds, a model's rate, a limit's share or a computer's price: none of it may come back in other words. */
export const PRIVATE_WORDS =
  /times as far|goes twice|counts at list price|a month, at list price|per 5 hours|per week|computer hours|% of the month|holds \$|bonus/;

/**
 * Every "$<digits>" in rendered markup that is not a price, a headline, a plan's name or one of `own` (the person's
 * own money, as it reads on the page: a balance, a top-up, a pay-as-you-go line), each with a little of what is around it.
 */
export function planDollars(markup: string, own: ReadonlyArray<string> = []): string[] {
  let rest = text(markup);
  // Whole amounts only: "$10" named as the person's own never hides the "$10" in "$105".
  for (const mine of [...own].sort((a, b) => b.length - a.length))
    rest = rest.replace(
      new RegExp(`${mine.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![.,]?\\d)`, "g"),
      " ",
    );
  for (const ok of ALLOWED) rest = rest.replace(ok, " ");
  return [...rest.matchAll(/.{0,24}\$\s?\d[\d,.]*.{0,24}/g)].map((m) => m[0].trim());
}
