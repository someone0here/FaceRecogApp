declare module 'react-native-sqlite-storage' {
  export interface SQLiteDatabase {
    executeSql(sql: string, params?: any[]): Promise<[SQLResultSet]>;
    close(): Promise<void>;
  }

  export interface SQLResultSet {
    rows: {
      length: number;
      item(index: number): any;
    };
    rowsAffected?: number;
  }

  export interface SQLiteDatabaseOptions {
    name: string;
    location?: string;
    createFromLocation?: string | boolean;
  }

  export function enablePromise(value: boolean): void;
  export function openDatabase(
    options: SQLiteDatabaseOptions,
  ): Promise<SQLiteDatabase>;

  const SQLite: {
    enablePromise(value: boolean): void;
    openDatabase(options: SQLiteDatabaseOptions): Promise<SQLiteDatabase>;
  };

  export default SQLite;
}
