import * as RDF from "rdf-js";
// tslint:disable-next-line:no-var-requires
const Parser = require('jsonparse');
import {IDocumentLoader, JsonLdContext} from "jsonld-context-parser";
import {Transform, TransformCallback} from "stream";
import {EntryHandlerArrayValue} from "./entryhandler/EntryHandlerArrayValue";
import {EntryHandlerContainer} from "./entryhandler/EntryHandlerContainer";
import {EntryHandlerInvalidFallback} from "./entryhandler/EntryHandlerInvalidFallback";
import {EntryHandlerPredicate} from "./entryhandler/EntryHandlerPredicate";
import {IEntryHandler} from "./entryhandler/IEntryHandler";
import {EntryHandlerKeywordContext} from "./entryhandler/keyword/EntryHandlerKeywordContext";
import {EntryHandlerKeywordGraph} from "./entryhandler/keyword/EntryHandlerKeywordGraph";
import {EntryHandlerKeywordId} from "./entryhandler/keyword/EntryHandlerKeywordId";
import {EntryHandlerKeywordType} from "./entryhandler/keyword/EntryHandlerKeywordType";
import {EntryHandlerKeywordUnknownFallback} from "./entryhandler/keyword/EntryHandlerKeywordUnknownFallback";
import {EntryHandlerKeywordValue} from "./entryhandler/keyword/EntryHandlerKeywordValue";
import {ParsingContext} from "./ParsingContext";
import {Util} from "./Util";

/**
 * A stream transformer that parses JSON-LD (text) streams to an {@link RDF.Stream}.
 */
export class JsonLdParser extends Transform {

  public static readonly DEFAULT_PROCESSING_MODE: string = '1.0';
  public static readonly ENTRY_HANDLERS: IEntryHandler<any>[] = [
    new EntryHandlerArrayValue(),
    new EntryHandlerKeywordContext(),
    new EntryHandlerKeywordId(),
    new EntryHandlerKeywordGraph(),
    new EntryHandlerKeywordType(),
    new EntryHandlerKeywordValue(),
    new EntryHandlerKeywordUnknownFallback(),
    new EntryHandlerContainer(),
    new EntryHandlerPredicate(),
    new EntryHandlerInvalidFallback(),
  ];

  private readonly parsingContext: ParsingContext;
  private readonly util: Util;

  private readonly jsonParser: any;
  // Jobs that are not started yet because of a missing @context
  private readonly contextAwaitingJobs: (() => Promise<void>)[];
  // Jobs that are not started yet that process a @context
  private readonly contextJobs: (() => Promise<void>)[];

  // The last depth that was processed.
  private lastDepth: number;
  // A promise representing the last job
  private lastOnValueJob: Promise<void>;

  constructor(options?: IJsonLdParserOptions) {
    super({ objectMode: true });
    options = options || {};
    this.parsingContext = new ParsingContext({ parser: this, ...options });
    this.util = new Util({ dataFactory: options.dataFactory, parsingContext: this.parsingContext });

    this.jsonParser = new Parser();
    this.contextAwaitingJobs = [];
    this.contextJobs = [];

    this.lastDepth = 0;
    this.lastOnValueJob = Promise.resolve();

    this.attachJsonParserListeners();
  }

  public _transform(chunk: any, encoding: string, callback: TransformCallback): void {
    this.jsonParser.write(chunk);
    this.lastOnValueJob
      .then(() => callback(), (error) => callback(error));
  }

  /**
   * Start a new job for parsing the given value.
   *
   * This will let the first valid {@link IEntryHandler} handle the entry.
   *
   * @param {any[]} keys The stack of keys.
   * @param value The value to parse.
   * @param {number} depth The depth to parse at.
   * @return {Promise<void>} A promise resolving when the job is done.
   */
  public async newOnValueJob(keys: any[], value: any, depth: number) {
    const keyOriginal = keys[depth];
    const key = await this.util.unaliasKeyword(keyOriginal, depth);
    const parentKey = await this.util.unaliasKeywordParent(keys, depth);
    this.parsingContext.emittedStack[depth] = true;
    let handleKey = true;

    // Keywords inside @reverse is not allowed
    if (Util.isKeyword(key) && parentKey === '@reverse') {
      this.emit('error', new Error(`Found the @id '${value}' inside an @reverse property`));
    }

    // Skip further processing if one of the parent nodes are invalid
    for (let i = 1; i < keys.length - 1; i++) {
      if (!await this.isValidKey(keys, i)) {
        this.parsingContext.emittedStack[depth] = false;
        handleKey = false;
        break;
      }
    }

    // Skip further processing if this node is part of a literal
    if (this.util.isLiteral(depth)) {
      handleKey = false;
    }

    // Get handler
    if (handleKey) {
      for (const entryHandler of JsonLdParser.ENTRY_HANDLERS) {
        const testResult = await entryHandler.test(this.parsingContext, this.util, key, keys, depth);
        if (testResult) {
          // Pass processing over to the handler
          await entryHandler.handle(this.parsingContext, this.util, key, keys, value, depth, testResult);
          break;
        }
      }

      // Flag that this depth is processed
      this.parsingContext.processingStack[depth] = true;
    }

    // When we go up the stack, emit all unidentified values
    if (depth < this.lastDepth) {
      // Check if we had any RDF lists that need to be terminated with an rdf:nil
      const listPointer = this.parsingContext.listPointerStack[this.lastDepth];
      if (listPointer) {
        if (listPointer.term) {
          this.emit('data', this.util.dataFactory.triple(listPointer.term, this.util.rdfRest, this.util.rdfNil));
        } else {
          this.parsingContext.getUnidentifiedValueBufferSafe(listPointer.listRootDepth)
            .push({ predicate: listPointer.initialPredicate, object: this.util.rdfNil, reverse: false });
        }
        delete this.parsingContext.listPointerStack[this.lastDepth];
      }

      // Flush the buffer for lastDepth
      await this.flushBuffer(this.lastDepth, keys);

      // Reset our stack
      delete this.parsingContext.processingStack[this.lastDepth];
      delete this.parsingContext.emittedStack[this.lastDepth];
      delete this.parsingContext.idStack[this.lastDepth];
      delete this.parsingContext.graphStack[this.lastDepth + 1];
      delete this.parsingContext.literalStack[this.lastDepth];
      if (!this.parsingContext.allowOutOfOrderContext) {
        // Only delete context if no out-of-order context is allowed,
        // because otherwise, we handle them in a different order.
        delete this.parsingContext.contextStack[this.lastDepth];
      }
    }
    this.lastDepth = depth;
  }

  /**
   * Return true if at least one {@link IEntryHandler} validates the entry to true.
   * @param {any[]} keys A stack of keys.
   * @param {number} depth A depth.
   * @return {Promise<boolean>} A promise resolving to true or false.
   */
  protected async isValidKey(keys: any[], depth: number): Promise<boolean> {
    for (const entryHandler of JsonLdParser.ENTRY_HANDLERS) {
      if (await entryHandler.validate(this.parsingContext, this.util, keys, depth)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Attach all required listeners to the JSON parser.
   *
   * This should only be called once.
   */
  protected attachJsonParserListeners() {
    // Listen to json parser events
    this.jsonParser.onValue = (value: any) => {
      const depth = this.jsonParser.stack.length;
      const keys = (new Array(depth + 1).fill(0)).map((v, i) => {
        return i === depth ? this.jsonParser.key : this.jsonParser.stack[i].key;
      });

      if (!this.isParsingContextInner(depth)) { // Don't parse inner nodes inside @context
        const valueJobCb = () => this.newOnValueJob(keys, value, depth);
        if (this.parsingContext.allowOutOfOrderContext && !this.parsingContext.contextStack[depth]) {
          // If an out-of-order context is allowed,
          // we have to buffer everything.
          // We store jobs for @context's separately,
          // because at the end, we have to process them first.
          if (keys[depth] === '@context') {
            this.contextJobs[depth] = valueJobCb;
          } else {
            this.contextAwaitingJobs.push(valueJobCb);
          }
        } else {
          // Make sure that our value jobs are chained synchronously
          this.lastOnValueJob = this.lastOnValueJob.then(valueJobCb);
        }

        // Execute all buffered jobs on deeper levels
        if (this.parsingContext.allowOutOfOrderContext && depth === 0) {
          this.lastOnValueJob = this.lastOnValueJob
            .then(() => this.executeBufferedJobs());
        }
      }
    };
    this.jsonParser.onError = (error: Error) => {
      this.emit('error', error);
    };
  }

  /**
   * Check if the parser is currently parsing an element that is part of an @context entry.
   * @param {number} depth A depth.
   * @return {boolean} A boolean.
   */
  protected isParsingContextInner(depth: number) {
    for (let i = depth; i > 0; i--) {
      if (this.jsonParser.stack[i - 1].key === '@context') {
        return true;
      }
    }
    return false;
  }

  /**
   * Execute all buffered jobs.
   * @return {Promise<void>} A promise resolving if all jobs are finished.
   */
  protected async executeBufferedJobs() {
    // Handle context jobs
    for (const job of this.contextJobs) {
      if (job) {
        await job();
      }
    }

    // Handle non-context jobs
    for (const job of this.contextAwaitingJobs) {
      await job();
    }
  }

  /**
   * Flush buffers for the given depth.
   *
   * This should be called after the last entry at a given depth was processed.
   *
   * @param {number} depth A depth.
   * @param {any[]} keys A stack of keys.
   * @return {Promise<void>} A promise resolving if flushing is done.
   */
  protected async flushBuffer(depth: number, keys: any[]) {
    let subject: RDF.Term = this.parsingContext.idStack[depth];
    if (subject === undefined) {
      subject = this.util.dataFactory.blankNode();
    }

    // Flush values at this level
    const valueBuffer: { predicate: RDF.Term, object: RDF.Term, reverse: boolean }[] =
      this.parsingContext.unidentifiedValuesBuffer[depth];
    if (valueBuffer) {
      if (subject) {
        const graph: RDF.Term = this.parsingContext.graphStack[depth]
        || await this.util.getDepthOffsetGraph(depth, keys) >= 0 ? this.parsingContext
          .idStack[depth - await this.util.getDepthOffsetGraph(depth, keys) - 1] : this.util.dataFactory.defaultGraph();
        if (graph) {
          // Flush values to stream if the graph @id is known
          for (const bufferedValue of valueBuffer) {
            if (bufferedValue.reverse) {
              this.parsingContext.emitQuad(depth, this.util.dataFactory.quad(
                bufferedValue.object, bufferedValue.predicate, subject, graph));
            } else {
              this.parsingContext.emitQuad(depth, this.util.dataFactory.quad(
                subject, bufferedValue.predicate, bufferedValue.object, graph));
            }
          }
        } else {
          // Place the values in the graphs buffer if the graph @id is not yet known
          const subGraphBuffer = this.parsingContext.getUnidentifiedGraphBufferSafe(
            depth - await this.util.getDepthOffsetGraph(depth, keys) - 1);
          for (const bufferedValue of valueBuffer) {
            if (bufferedValue.reverse) {
              subGraphBuffer.push({
                object: subject,
                predicate: bufferedValue.predicate,
                subject: bufferedValue.object,
              });
            } else {
              subGraphBuffer.push({
                object: bufferedValue.object,
                predicate: bufferedValue.predicate,
                subject,
              });
            }
          }
        }
      }
      delete this.parsingContext.unidentifiedValuesBuffer[depth];
      delete this.parsingContext.literalStack[depth];
    }

    // Flush graphs at this level
    const graphBuffer: { subject: RDF.Term, predicate: RDF.Term, object: RDF.Term }[] =
      this.parsingContext.unidentifiedGraphsBuffer[depth];
    if (graphBuffer) {
      if (subject) {
        // A @graph statement at the root without @id relates to the default graph,
        // unless there are top-level properties,
        // others relate to blank nodes.
        const graph: RDF.Term = depth === 1 && subject.termType === 'BlankNode'
        && !this.parsingContext.topLevelProperties ? this.util.dataFactory.defaultGraph() : subject;
        for (const bufferedValue of graphBuffer) {
          this.parsingContext.emitQuad(depth, this.util.dataFactory.quad(
            bufferedValue.subject, bufferedValue.predicate, bufferedValue.object, graph));
        }
      }
      delete this.parsingContext.unidentifiedGraphsBuffer[depth];
    }
  }
}

/**
 * Constructor arguments for {@link JsonLdParser}
 */
export interface IJsonLdParserOptions {
  /**
   * A data factory.
   */
  dataFactory?: RDF.DataFactory;
  /**
   * The root context.
   */
  context?: JsonLdContext;
  /**
   * The base IRI.
   */
  baseIRI?: string;
  /**
   * If @context definitions should be allowed as non-first object entries.
   * When enabled, streaming results may not come as soon as possible,
   * and will be buffered until the end when no context is defined at all.
   * Defaults to false.
   */
  allowOutOfOrderContext?: boolean;
  /**
   * Loader for remote contexts.
   */
  documentLoader?: IDocumentLoader;
  /**
   * If blank node predicates should be allowed,
   * they will be ignored otherwise.
   * Defaults to false.
   */
  produceGeneralizedRdf?: boolean;
  /**
   * The maximum JSON-LD version that should be processable by this parser.
   * Defaults to JsonLdParser.DEFAULT_PROCESSING_MODE.
   */
  processingMode?: string;
  /**
   * By default, JSON-LD requires that
   * all properties (or @id's) that are not URIs,
   * are unknown keywords,
   * and do not occur in the context
   * should be silently dropped.
   * When setting this value to true,
   * an error will be thrown when such properties occur.
   * Defaults to false.
   */
  errorOnInvalidIris?: boolean;
}
