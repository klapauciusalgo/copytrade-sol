import { Queue, Worker, QueueEvents } from 'bullmq';
import IORedis from 'ioredis';

const connection = new IORedis({
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379', 10),
  maxRetriesPerRequest: null,
});

// Execution Queue setup
export const executionQueue = new Queue('executionQueue', { connection });
export const executionQueueEvents = new QueueEvents('executionQueue', { connection });

// Notification Queue setup
export const notificationQueue = new Queue('notificationQueue', { connection });
export const notificationQueueEvents = new QueueEvents('notificationQueue', { connection });

export { connection };
