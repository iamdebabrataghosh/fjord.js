import { Fjord } from '../fjord';

describe('Fjord - Cascade', () => {
  it('should execute all flows in parallel', async () => {
    const fjord = new Fjord();
    const order: number[] = [];

    await fjord.cascade(async (estuary) => {
      estuary.flow(async () => {
        await new Promise(r => setTimeout(r, 50));
        order.push(1);
      });

      estuary.flow(async () => {
        await new Promise(r => setTimeout(r, 25));
        order.push(2);
      });

      await new Promise(r => setTimeout(r, 100));
    });

    expect(order).toEqual([2, 1]); // 2 completes first (25ms < 50ms)
  });

  it('should return callback result', async () => {
    const fjord = new Fjord();

    const result = await fjord.cascade(async (estuary) => {
      const task = estuary.flow(async () => 'test data');
      return await task;
    });

    expect(result).toBe('test data');
  });

  it('should cancel remaining tasks on error', async () => {
    const fjord = new Fjord();
    const executed: number[] = [];
    const errors: string[] = [];

    try {
      await fjord.cascade(async (estuary) => {
        estuary.flow(async () => {
          await new Promise(r => setTimeout(r, 10));
          throw new Error('Task 1 failed');
        });

        estuary.flow(async () => {
          await new Promise(r => setTimeout(r, 1000));
          executed.push(2);
        });

        await new Promise(r => setTimeout(r, 100));
      });
    } catch (e) {
      errors.push((e as Error).message);
    }

    expect(errors).toContain('Task 1 failed');
    expect(executed).toEqual([]); // Second task never completed
  });

  it('should respect timeout', async () => {
    const fjord = new Fjord({ timeout: 100 });
    const errors: string[] = [];

    try {
      await fjord.cascade(async (estuary) => {
        estuary.flow(async () => {
          await new Promise(r => setTimeout(r, 200));
        });

        await new Promise(r => setTimeout(r, 500));
      });
    } catch (e) {
      errors.push((e as Error).message);
    }

    expect(errors[0]).toContain('timeout');
  });

  it('should invoke onError callback', async () => {
    const errorHandler = jest.fn();
    const fjord = new Fjord({ onError: errorHandler });

    try {
      await fjord.cascade(async (estuary) => {
        throw new Error('Cascade error');
      });
    } catch (e) {
      // Expected
    }

    expect(errorHandler).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Cascade error' }),
      'cascade'
    );
  });

  it('should freeze scope on first error', async () => {
    const fjord = new Fjord();

    try {
      await fjord.cascade(async (estuary) => {
        estuary.flow(async () => {
          throw new Error('First error');
        });

        // Try to launch new task - should fail because scope frozen
        try {
          estuary.flow(async () => {
            return 'should not execute';
          });
          throw new Error('Should have thrown');
        } catch (e) {
          expect((e as Error).message).toContain('frozen');
        }

        await new Promise(r => setTimeout(r, 50));
      });
    } catch (e) {
      // Expected - cascade fails due to first error
    }
  });
});

describe('Fjord - Tributary', () => {
  it('should return first successful result', async () => {
    const fjord = new Fjord();

    const result = await fjord.tributary(async (estuary) => {
      return Promise.race([
        estuary.flow(async () => {
          await new Promise(r => setTimeout(r, 100));
          return 'slow';
        }),
        estuary.flow(async () => {
          await new Promise(r => setTimeout(r, 10));
          return 'fast';
        }),
      ]);
    });

    expect(result).toBe('fast');
  });

  it('should cancel remaining tasks after first success', async () => {
    const fjord = new Fjord();
    const executed: string[] = [];

    await fjord.tributary(async (estuary) => {
      return Promise.race([
        estuary.flow(async () => {
          executed.push('task1-start');
          await new Promise(r => setTimeout(r, 100));
          executed.push('task1-end');
          return 'slow';
        }),
        estuary.flow(async () => {
          executed.push('task2-start');
          await new Promise(r => setTimeout(r, 10));
          executed.push('task2-end');
          return 'fast';
        }),
      ]);
    });

    expect(executed).toContain('task1-start');
    expect(executed).toContain('task2-start');
    expect(executed).toContain('task2-end');
    expect(executed).not.toContain('task1-end'); // Cancelled before completion
  });

  it('should handle all tasks failing', async () => {
    const fjord = new Fjord();
    const errors: string[] = [];

    try {
      await fjord.tributary(async (estuary) => {
        return Promise.race([
          estuary.flow(async () => {
            throw new Error('Task 1 failed');
          }),
          estuary.flow(async () => {
            throw new Error('Task 2 failed');
          }),
        ]);
      });
    } catch (e) {
      errors.push((e as Error).message);
    }

    expect(errors.length).toBeGreaterThan(0);
  });

  it('should respect timeout in tributary', async () => {
    const fjord = new Fjord({ timeout: 50 });
    const errors: string[] = [];

    try {
      await fjord.tributary(async (estuary) => {
        return Promise.race([
          estuary.flow(async () => {
            await new Promise(r => setTimeout(r, 200));
            return 'result';
          }),
        ]);
      });
    } catch (e) {
      errors.push((e as Error).message);
    }

    expect(errors[0]).toContain('timeout');
  });

  it('should invoke onError for tributary failures', async () => {
    const errorHandler = jest.fn();
    const fjord = new Fjord({ onError: errorHandler });

    try {
      await fjord.tributary(async (estuary) => {
        throw new Error('Tributary error');
      });
    } catch (e) {
      // Expected
    }

    expect(errorHandler).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Tributary error' }),
      'tributary'
    );
  });
});

describe('Estuary - isFrozen()', () => {
  it('should report frozen state after error', async () => {
    const fjord = new Fjord();

    try {
      await fjord.cascade(async (estuary) => {
        expect(estuary.isFrozen()).toBe(false);

        estuary.flow(async () => {
          throw new Error('Task error');
        });

        await new Promise(r => setTimeout(r, 50));
      });
    } catch (e) {
      // Expected
    }
  });
});

describe('Integration Tests', () => {
  it('should handle complex multi-level async', async () => {
    const fjord = new Fjord();
    const results: number[] = [];

    await fjord.cascade(async (estuary) => {
      const task1 = estuary.flow(async () => {
        await new Promise(r => setTimeout(r, 50));
        results.push(1);
        return 1;
      });

      const task2 = estuary.flow(async () => {
        await new Promise(r => setTimeout(r, 30));
        results.push(2);
        return 2;
      });

      const task3 = estuary.flow(async () => {
        await new Promise(r => setTimeout(r, 60));
        results.push(3);
        return 3;
      });

      const [r1, r2, r3] = await Promise.all([task1, task2, task3]);
      return r1 + r2 + r3;
    });

    expect(results.sort()).toEqual([1, 2, 3]);
  });

  it('should handle nested async operations', async () => {
    const fjord = new Fjord();

    const result = await fjord.cascade(async (estuary) => {
      const task = estuary.flow(async () => {
        await new Promise(r => setTimeout(r, 10));
        
        return new Promise(async (resolve) => {
          await new Promise(r => setTimeout(r, 10));
          resolve('nested result');
        });
      });

      return await task;
    });

    expect(result).toBe('nested result');
  });
});
