import { afterEach, beforeEach, describe, it } from 'bun:test';
import type { INestApplication } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import request from 'supertest';
import type { Server } from 'node:http';
import { AppModule } from '../src/app.module.js';

describe('AppController (e2e)', () => {
  let app: INestApplication;
  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    await app.init();
  });
  afterEach(async () => {
    await app.close();
  });
  it('GET / returns the NestJS starter response', async () => {
    await request(app.getHttpServer() as Server).get('/').expect(200).expect('Hello World!');
  });
});
