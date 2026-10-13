'use strict';

/**
 * Semaforo contato: limita le letture Modbus in volo.
 *
 * Cento richieste simultanee su una rete industriale di cliente
 * producono ritrasmissioni e timeout che sembrano guasti dei contatori.
 * Con 100 device a 15 s e ~80 ms per lettura, 20 slot bastano
 * abbondantemente (ciclo completo in meno di un secondo).
 */
class Semaphore {
  constructor(limit) {
    this.limit = limit;
    this.active = 0;
    this.queue = [];
  }

  async acquire() {
    if (this.active < this.limit) {
      this.active += 1;
      return;
    }
    await new Promise((resolve) => this.queue.push(resolve));
    this.active += 1;
  }

  release() {
    this.active -= 1;
    const next = this.queue.shift();
    if (next) next();
  }

  async run(fn) {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  get pending() { return this.queue.length; }
}

module.exports = { Semaphore };
