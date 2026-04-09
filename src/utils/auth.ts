import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { User } from '../types';
import { normalizeAvatarUrl } from './public-url';

const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';
const JWT_EXPIRES_IN = '7d';

export const hashPassword = async (password: string): Promise<string> => {
  const saltRounds = 10;
  return bcrypt.hash(password, saltRounds);
};

export const comparePassword = async (password: string, hashedPassword: string): Promise<boolean> => {
  return bcrypt.compare(password, hashedPassword);
};

export const generateToken = (user: User): string => {
  return jwt.sign(
    {
      id: user.id,
      username: user.username,
      displayName: user.displayName
    },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );
};

export const verifyToken = (token: string): any => {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (error) {
    throw new Error('Invalid token');
  }
};

export const createSafeUser = (
  user: User,
  publicBase?: string
): Omit<User, 'passwordHash' | 'fcmTokens'> => {
  const { passwordHash, fcmTokens: _fcm, ...safeUser } = user;
  if (!publicBase) return safeUser;
  return {
    ...safeUser,
    avatar: normalizeAvatarUrl(safeUser.avatar, publicBase) ?? safeUser.avatar
  };
};