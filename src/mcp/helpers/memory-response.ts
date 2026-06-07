type InternalMemoryFields = {
  id?: string;
  space_name: string;
  access_count?: number;
  last_accessed_at?: string | null;
  embedding?: unknown;
  created_at?: string;
  updated_at?: string;
  fts_id?: number;
  space_id?: string;
};

type InternalSpaceFields = {
  created_at?: string;
  updated_at: string;
};

type InternalHotMemoryFields = {
  id?: string;
  space_name?: string;
  access_count?: number;
  last_accessed_at?: string | null;
  embedding?: unknown;
  content?: string;
  created_at?: string;
  updated_at?: string;
  changed_at?: string;
  space_id?: string;
};

export function presentMemoryResponse<T extends InternalMemoryFields>(obj: T) {
  const {
    id: _id,
    space_name,
    access_count: _access_count,
    last_accessed_at: _last_accessed_at,
    embedding: _embedding,
    created_at: _created_at,
    updated_at: _updated_at,
    fts_id: _fts_id,
    space_id: _space_id,
    ...rest
  } = obj;

  return {
    ...rest,
    space: space_name,
  };
}

export function presentSpaceResponse<T extends InternalSpaceFields>(obj: T) {
  const { created_at: _created_at, updated_at, ...rest } = obj;

  return {
    ...rest,
    changed_at: updated_at,
  };
}

export function presentHotMemoryResponse<T extends InternalHotMemoryFields>(obj: T) {
  const {
    id: _id,
    space_name: _space_name,
    access_count: _access_count,
    last_accessed_at: _last_accessed_at,
    embedding: _embedding,
    content: _content,
    created_at: _created_at,
    updated_at,
    changed_at,
    space_id: _space_id,
    ...rest
  } = obj;

  return {
    ...rest,
    changed_at: changed_at ?? updated_at,
  };
}
