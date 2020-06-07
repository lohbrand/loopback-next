// Copyright IBM Corp. 2020. All Rights Reserved.
// Node module: @loopback/pooling
// This file is licensed under the MIT License.
// License text available at https://opensource.org/licenses/MIT

import {
  bind,
  BindingAddress,
  BindingScope,
  config,
  Context,
  inject,
  LifeCycleObserver,
  ValueOrPromise,
} from '@loopback/core';
import debugFactory from 'debug';
import {createPool, Factory, Options, Pool} from 'generic-pool';

const debug = debugFactory('loopback:pooling');

/**
 * Factory for the pooling service
 */
export interface PoolFactory<T> extends Factory<T> {
  /**
   * To be called right after the resource is acquired from the pool. If it
   * fails, the resource will be destroyed from the pool. The method should be
   * used to set up the acquired resource.
   */
  acquire?(resource: T): ValueOrPromise<void>;
  /**
   * To be called right before the resource is released to the pool. If it
   * fails, the resource will be destroyed from the pool. This method should be
   * used to clean up the resource to be returned.
   */
  release?(resource: T): ValueOrPromise<void>;
}

/**
 * Options to configure a resource pool
 */
export interface PoolingServiceOptions<T> {
  /**
   * A factory to create/destroy/validate resources for the pool or a function
   * to create a factory for the given context
   */
  factory: PoolFactory<T> | ((ctx: Context) => PoolFactory<T>);
  /**
   * Options for the generic pool
   */
  poolOptions?: Options;
}

/**
 * Life cycle methods that a poolable resource can optionally implement so that
 * they can be triggered by the pooling service
 */
export interface Poolable extends LifeCycleObserver {
  /**
   * To be called right after the resource is acquired from the pool. If it
   * fails, the resource will be destroyed from the pool. The method should be
   * used to set up the acquired resource.
   */
  acquire?(): ValueOrPromise<void>;
  /**
   * To be called right before the resource is released to the pool. If it
   * fails, the resource will be destroyed from the pool. This method should be
   * used to clean up the resource to be returned.
   */
  release?(): ValueOrPromise<void>;
}

/**
 * Pooled resource instance
 */
export interface PooledValue<T> {
  /**
   * The resource pool
   */
  pool: Pool<T>;
  /**
   * Acquired value from the pool
   */
  value: T;
  /**
   * The function to release the acquired value back to the pool
   */
  release(): Promise<void>;
}

/**
 * Acquire a resource from the pooling service or pool
 * @param poolingService - Pooling service or pool
 */
export async function getPooledValue<T>(
  poolingService: PoolingService<T> | Pool<T>,
): Promise<PooledValue<T>> {
  const value = await poolingService.acquire();
  const pool =
    poolingService instanceof PoolingService
      ? poolingService.pool
      : poolingService;
  return {
    pool,
    value,
    async release() {
      return poolingService.release(value);
    },
  };
}

/**
 * A singleton service to maintain a pool of resources. This pool service can
 * be bound to different keys to represent multiple pools. Each binding is a
 * singleton so that the state stays the same for injections into multiple
 * instances for other artifacts.
 *
 * @remarks
 *
 * Some resources can be expensive to create/start. For example, a datasource
 * has overhead to connect to the database. There will be performance penalty
 * to use `TRANSIENT` scope and creates a new instance per request. But it is
 * not feasible to be a singleton for some use cases, for example, each request
 * may have different security contexts.
 *
 * The pool service observes life cycle events to start and stop.
 */
@bind({scope: BindingScope.SINGLETON})
export class PoolingService<T> implements LifeCycleObserver {
  private readonly factory: PoolFactory<T>;
  /**
   * The resource pool
   */
  readonly pool: Pool<T>;

  constructor(
    @inject.context() readonly context: Context,
    @config() private options: PoolingServiceOptions<T>,
  ) {
    let factory = this.options.factory;
    if (typeof factory === 'function') {
      factory = factory(this.context);
    }
    this.factory = factory;
    this.options = {...options, factory};
    this.pool = createPool(factory, {
      max: 8, // Default to 8 instances
      ...this.options.poolOptions,
      autostart: false,
    });
  }

  /**
   * Start the pool
   */
  start() {
    if (this.options.poolOptions?.autostart !== false) {
      debug('Starting pool for context %s', this.context.name);
      this.pool.start();
    }
  }

  /**
   * Stop the pool
   */
  async stop() {
    debug('Stopping pool for context %s', this.context.name);
    if (this.pool == null) return;
    await this.pool.drain();
    await this.pool.clear();
  }

  /**
   * Acquire a new instance
   */
  async acquire() {
    debug(
      'Acquiring a resource from the pool in context %s',
      this.context.name,
    );
    const resource = await this.pool.acquire();

    try {
      // Try factory-level acquire hook first
      if (this.factory.acquire) {
        await this.factory.acquire(resource);
      } else {
        // Fall back to resource-level acquire hook
        await invokePoolableMethod(resource, 'acquire');
      }
    } catch (err) {
      await this.pool.destroy(resource);
      throw err;
    }
    debug(
      'Resource acquired from the pool in context %s',
      this.context.name,
      resource,
    );
    return resource;
  }

  /**
   * Release the resource back to the pool.
   * @param resource - Resource instance to be returned back to the pool
   */
  async release(resource: T) {
    debug(
      'Releasing a resource from the pool in context %s',
      this.context.name,
      resource,
    );
    try {
      // Try factory-level acquire hook first
      if (this.factory.release) {
        await this.factory.release(resource);
      } else {
        await invokePoolableMethod(resource, 'release');
      }
      await this.pool.release(resource);
    } catch (err) {
      await this.pool.destroy(resource);
      throw err;
    }
    debug(
      'Resource released to the pool in context %s',
      this.context.name,
      resource,
    );
  }

  /**
   * Destroy a resource from the pool
   * @param resource - Resource instance to be destroyed
   */
  async destroy(resource: T) {
    debug(
      'Destroying a resource from the pool in context %s',
      this.context.name,
      resource,
    );
    await this.pool.destroy(resource);
    debug('Resource destroyed in context %s', this.context.name, resource);
  }

  /**
   * Run the task with an acquired resource from the pool. If task is completed
   * successfully, the resource is returned to the pool. Otherwise, the
   * resource is destroyed.
   *
   * @param task -  A function that accepts a resource and returns a Promise.
   */
  async run(task: (resource: T) => ValueOrPromise<void>) {
    const resource = await this.acquire();
    try {
      await task(resource);
    } catch (err) {
      await this.destroy(resource);
      throw err;
    }
    await this.release(resource);
  }
}

/**
 * Create a function to return a pooled binding factory
 * @param bindingAddress - Binding address
 */
export function createPooledBindingFactory<T extends object>(
  bindingAddress: BindingAddress<T>,
): (context: Context) => PoolFactory<T> {
  const bindingPoolFactory = (context: Context): PoolFactory<T> =>
    new PooledBindingFactory(context, bindingAddress);
  return bindingPoolFactory;
}

/**
 * Factory for pooled binding values. This is specialized factory to create
 * new resources from the binding. If the bound value observes life cycle events,
 * the `start` method is called by `create` and the `stop` method is called
 * by `destroy`.
 */
class PooledBindingFactory<T extends object> implements PoolFactory<T> {
  constructor(
    private readonly context: Context,
    private readonly bindingAddress: BindingAddress<T>,
  ) {}

  async create() {
    debug(
      'Creating a resource for %s#%s',
      this.context.name,
      this.bindingAddress,
    );
    const value = await this.context.get(this.bindingAddress);
    await invokePoolableMethod(value, 'start');
    return value;
  }
  async destroy(value: T) {
    debug(
      'Destroying a resource for %s#%s',
      this.context.name,
      this.bindingAddress,
      value,
    );
    await invokePoolableMethod(value, 'stop');
  }
}

function invokePoolableMethod(resource: Poolable, method: keyof Poolable) {
  if (typeof resource[method] === 'function') {
    return resource[method]!();
  }
}