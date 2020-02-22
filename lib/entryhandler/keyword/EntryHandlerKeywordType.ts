import {ParsingContext} from "../../ParsingContext";
import {Util} from "../../Util";
import {EntryHandlerPredicate} from "../EntryHandlerPredicate";
import {EntryHandlerKeyword} from "./EntryHandlerKeyword";
import {IJsonLdContextNormalized} from "jsonld-context-parser/lib/JsonLdContext";

/**
 * Handles @graph entries.
 */
export class EntryHandlerKeywordType extends EntryHandlerKeyword {

  constructor() {
    super('@type');
  }

  public async handle(parsingContext: ParsingContext, util: Util, key: any, keys: any[], value: any, depth: number)
    : Promise<any> {
    const keyOriginal = keys[depth];

    // The current identifier identifies an rdf:type predicate.
    // But we only emit it once the node closes,
    // as it's possible that the @type is used to identify the datatype of a literal, which we ignore here.
    const context = await parsingContext.getContext(keys);
    const predicate = util.rdfType;
    const reverse = Util.isPropertyReverse(context, keyOriginal, await util.unaliasKeywordParent(keys, depth));

    // Handle multiple values if the value is an array
    const elements = Array.isArray(value) ? value : [ value ];
    for (const element of elements) {
      const type = util.createVocabOrBaseTerm(context, element);
      if (type) {
        await EntryHandlerPredicate.handlePredicateObject(parsingContext, util, keys, depth,
          predicate, type, reverse);
      }
    }

    // Collect type-scoped contexts if they exist
    let scopedContext: Promise<IJsonLdContextNormalized> = Promise.resolve(context);
    let hasTypedScopedContext = false;
    for (const element of elements.sort()) { // Spec requires lexicographical ordering
      const typeContext = Util.getContextValue(context, '@context', element, null);
      if (typeContext) {
        hasTypedScopedContext = true;
        scopedContext = scopedContext.then((c) => parsingContext.parseContext(typeContext, c));
      }
    }
    // If at least least one type-scoped context applies, set them in the tree.
    if (hasTypedScopedContext) {
      parsingContext.contextTree.setContext(keys.slice(0, keys.length - 1), scopedContext);
    }
  }

}
