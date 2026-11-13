import { MemoryAdapter } from '../src/index.js';
import { clusterSuite } from './cluster-suite.js';

clusterSuite('memory', () => new MemoryAdapter());
