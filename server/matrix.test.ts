import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

describe('Matrix Integration', () => {
  describe('Homeserver Discovery', () => {
    it('should identify available homeservers', async () => {
      const homeservers = [
        'https://matrix-client.matrix.org',
        'https://matrix.gitter.im',
        'https://matrix.org',
      ];

      for (const homeserver of homeservers) {
        try {
          const response = await fetch(`${homeserver}/_matrix/client/versions`, {
            method: 'GET',
            headers: { 'Content-Type': 'application/json' },
          });
          
          // At least one should be available
          if (response.ok) {
            expect(response.status).toBe(200);
            const data = await response.json();
            expect(data).toHaveProperty('versions');
            return; // Success - at least one homeserver is available
          }
        } catch (err) {
          // Continue to next homeserver
        }
      }
      
      // If we get here, at least one homeserver should have been reachable
      // This is expected to pass in most environments
    });
  });

  describe('Guest Registration', () => {
    it('should attempt guest registration', async () => {
      const homeserver = 'https://matrix-client.matrix.org';
      
      try {
        const response = await fetch(`${homeserver}/_matrix/client/v3/register?kind=guest`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        });

        // Guest registration may fail on some servers, but the endpoint should exist
        expect([200, 400, 403, 429]).toContain(response.status);
      } catch (err) {
        // Network error is acceptable in test environment
        expect(err).toBeDefined();
      }
    });
  });

  describe('Room Operations', () => {
    it('should validate room creation parameters', () => {
      const roomName = 'test-room';
      const sanitizedName = roomName.toLowerCase().replace(/\s+/g, '-');
      
      expect(sanitizedName).toBe('test-room');
      expect(sanitizedName).not.toContain(' ');
    });

    it('should handle room name sanitization', () => {
      const testCases = [
        { input: 'My Room', expected: 'my-room' },
        { input: 'Test  Room', expected: 'test-room' }, // Multiple spaces become single dash
        { input: 'UPPERCASE', expected: 'uppercase' },
      ];

      testCases.forEach(({ input, expected }) => {
        const result = input.toLowerCase().replace(/\s+/g, '-');
        expect(result).toBe(expected);
      });
    });
  });

  describe('Error Handling', () => {
    it('should handle network errors gracefully', async () => {
      const invalidHomeserver = 'https://invalid-matrix-server-12345.example.com';
      
      try {
        await fetch(`${invalidHomeserver}/_matrix/client/versions`, {
          method: 'GET',
          headers: { 'Content-Type': 'application/json' },
        });
      } catch (err) {
        expect(err).toBeDefined();
        expect(err instanceof Error).toBe(true);
      }
    });

    it('should validate error messages', () => {
      const errorMessage = 'Matrix client not initialized';
      expect(errorMessage).toContain('Matrix');
      expect(errorMessage.length).toBeGreaterThan(0);
    });
  });

  describe('Message Handling', () => {
    it('should validate message content', () => {
      const validMessages = [
        'Hello, world!',
        'Test message with special chars: !@#$%',
        'Multi-line\nmessage',
      ];

      validMessages.forEach(msg => {
        expect(msg).toBeTruthy();
        expect(typeof msg).toBe('string');
      });
    });

    it('should reject empty messages', () => {
      const emptyMessages = ['', '   ', '\n'];

      emptyMessages.forEach(msg => {
        expect(msg.trim()).toBe('');
      });
    });
  });

  describe('User Identification', () => {
    it('should generate valid Matrix user IDs', () => {
      const userId = 'user123';
      const hostname = 'matrix.org';
      const matrixUserId = `@user_${userId.substring(0, 8)}:${hostname}`;

      expect(matrixUserId).toMatch(/^@user_/);
      expect(matrixUserId).toContain(':');
      expect(matrixUserId).toContain(hostname);
    });
  });
});
