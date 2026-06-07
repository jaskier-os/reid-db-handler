#!/usr/bin/env python3
"""
FAISS Server
Standalone Python service for FAISS face database operations
Communicates via JSON over stdin/stdout
"""

import sys
import os
import json
import numpy as np
import faiss
import logging
from typing import Tuple, List

# Configure logging to stderr (stdout is used for JSON communication)
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    stream=sys.stderr
)
logger = logging.getLogger(__name__)


class FaissServer:
    """FAISS database server for face recognition"""

    def __init__(self, db_path: str, embedding_size: int = 512):
        """
        Initialize FAISS server

        Args:
            db_path: Directory to store database files
            embedding_size: Dimension of face embeddings (default 512)
        """
        self.db_path = db_path
        self.embedding_size = embedding_size
        self.index_file = os.path.join(db_path, "faiss_index.bin")
        self.meta_file = os.path.join(db_path, "metadata.json")

        os.makedirs(db_path, exist_ok=True)

        # Initialize FAISS index (inner product for cosine similarity)
        self.index = faiss.IndexFlatIP(embedding_size)

        # Metadata: person IDs/names for each embedding
        self.metadata = []

        # Load existing database if available
        self.load()

    def load(self) -> bool:
        """Load FAISS index and metadata from disk"""
        if os.path.exists(self.index_file) and os.path.exists(self.meta_file):
            try:
                self.index = faiss.read_index(self.index_file)
                with open(self.meta_file, 'r', encoding='utf-8') as f:
                    self.metadata = json.load(f)
                logger.info(f"Loaded FAISS database with {self.index.ntotal} faces")
                return True
            except Exception as e:
                logger.error(f"Failed to load FAISS database: {e}")
                return False
        return False

    def save(self) -> bool:
        """Save FAISS index and metadata to disk"""
        try:
            faiss.write_index(self.index, self.index_file)
            with open(self.meta_file, 'w', encoding='utf-8') as f:
                json.dump(self.metadata, f, ensure_ascii=False, indent=2)
            logger.info(f"Saved FAISS database with {self.index.ntotal} faces")
            return True
        except Exception as e:
            logger.error(f"Failed to save FAISS database: {e}")
            return False

    def search(self, embedding: List[float], threshold: float = 0.4) -> dict:
        """
        Search for a face in the database

        Args:
            embedding: Face embedding vector
            threshold: Similarity threshold

        Returns:
            Dict with name and similarity score
        """
        if self.index.ntotal == 0:
            return {"name": "Unknown", "similarity": 0.0}

        # Normalize embedding
        emb_np = np.array(embedding, dtype=np.float32)
        emb_normalized = emb_np / np.linalg.norm(emb_np)

        # Search
        similarities, indices = self.index.search(
            np.array([emb_normalized], dtype=np.float32), 1
        )

        similarity = float(similarities[0][0])
        idx = int(indices[0][0])

        if similarity >= threshold and idx < len(self.metadata):
            return {"name": self.metadata[idx], "similarity": similarity}

        return {"name": "Unknown", "similarity": similarity}

    def batch_search(self, embeddings: List[List[float]], threshold: float = 0.4) -> List[dict]:
        """
        Batch search for multiple faces

        Args:
            embeddings: List of face embeddings
            threshold: Similarity threshold

        Returns:
            List of dicts with name and similarity scores
        """
        if self.index.ntotal == 0:
            return [{"name": "Unknown", "similarity": 0.0} for _ in embeddings]

        # Normalize all embeddings
        emb_np = np.array(embeddings, dtype=np.float32)
        emb_normalized = emb_np / np.linalg.norm(emb_np, axis=1, keepdims=True)

        # Batch search
        similarities, indices = self.index.search(emb_normalized, 1)

        results = []
        for i in range(len(embeddings)):
            similarity = float(similarities[i][0])
            idx = int(indices[i][0])

            if similarity >= threshold and idx < len(self.metadata):
                results.append({"name": self.metadata[idx], "similarity": similarity})
            else:
                results.append({"name": "Unknown", "similarity": similarity})

        return results

    def add_face(self, embedding: List[float], name: str) -> dict:
        """
        Add a face to the database

        Args:
            embedding: Face embedding vector
            name: Person identifier/name

        Returns:
            Dict with success status
        """
        # Normalize embedding
        emb_np = np.array(embedding, dtype=np.float32)
        emb_normalized = emb_np / np.linalg.norm(emb_np)

        # Add to index
        self.index.add(np.array([emb_normalized], dtype=np.float32))
        self.metadata.append(name)

        return {"success": True, "total": self.index.ntotal}

    def add_faces_batch(self, embeddings: List[List[float]], names: List[str]) -> dict:
        """
        Add multiple faces to the database

        Args:
            embeddings: List of face embeddings
            names: List of person identifiers

        Returns:
            Dict with success status and count
        """
        if len(embeddings) != len(names):
            raise ValueError("embeddings and names must have same length")

        # Normalize all embeddings
        emb_np = np.array(embeddings, dtype=np.float32)
        emb_normalized = emb_np / np.linalg.norm(emb_np, axis=1, keepdims=True)

        # Add to index
        self.index.add(emb_normalized)
        self.metadata.extend(names)

        return {"success": True, "count": len(embeddings), "total": self.index.ntotal}

    def search_similar(self, embedding: List[float], k: int = 10, threshold: float = 0.4) -> List[dict]:
        """
        Search for top-K similar faces in the database

        Args:
            embedding: Face embedding vector
            k: Number of results to return
            threshold: Minimum similarity threshold

        Returns:
            List of dicts with name and similarity score
        """
        if self.index.ntotal == 0:
            return []

        emb_np = np.array(embedding, dtype=np.float32)
        emb_normalized = emb_np / np.linalg.norm(emb_np)

        actual_k = min(k, self.index.ntotal)
        similarities, indices = self.index.search(
            np.array([emb_normalized], dtype=np.float32), actual_k
        )

        results = []
        for i in range(actual_k):
            similarity = float(similarities[0][i])
            idx = int(indices[0][i])
            if similarity >= threshold and idx < len(self.metadata):
                results.append({"name": self.metadata[idx], "similarity": similarity})

        return results

    def rename_person(self, old_name: str, new_name: str) -> dict:
        """
        Rename all entries for a person (used after merge).
        Simply relabels metadata -- no index rebuild needed.
        """
        count = 0
        for i, m in enumerate(self.metadata):
            if m == old_name:
                self.metadata[i] = new_name
                count += 1
        return {"success": True, "renamed": count}

    def remove_person(self, name: str) -> dict:
        """
        Remove all entries for a given person and rebuild index.
        """
        keep_indices = [i for i, m in enumerate(self.metadata) if m != name]
        removed = len(self.metadata) - len(keep_indices)

        if removed == 0:
            return {"success": True, "removed": 0, "total": self.index.ntotal}

        if len(keep_indices) == 0:
            # All entries removed -- reset index
            self.index = faiss.IndexFlatIP(self.embedding_size)
            self.metadata = []
            return {"success": True, "removed": removed, "total": 0}

        # Reconstruct kept embeddings
        kept_embeddings = np.zeros((len(keep_indices), self.embedding_size), dtype=np.float32)
        for new_idx, old_idx in enumerate(keep_indices):
            self.index.reconstruct(old_idx, kept_embeddings[new_idx])

        kept_metadata = [self.metadata[i] for i in keep_indices]

        # Rebuild index
        self.index = faiss.IndexFlatIP(self.embedding_size)
        self.index.add(kept_embeddings)
        self.metadata = kept_metadata

        return {"success": True, "removed": removed, "total": self.index.ntotal}

    def get_stats(self) -> dict:
        """Get database statistics"""
        return {
            "total_faces": self.index.ntotal,
            "metadata_count": len(self.metadata),
            "embedding_size": self.embedding_size
        }


def send_response(request_id, result=None, error=None):
    """Send JSON response to stdout"""
    response = {
        "request_id": request_id,
        "result": result,
        "error": error
    }
    print(json.dumps(response), flush=True)


def main():
    """Main server loop"""
    if len(sys.argv) < 2:
        logger.error("Usage: faiss_server.py <db_path>")
        sys.exit(1)

    db_path = sys.argv[1]

    try:
        # Initialize FAISS server
        server = FaissServer(db_path)

        # Send ready signal
        ready_signal = {
            "type": "ready",
            "count": server.index.ntotal
        }
        print(json.dumps(ready_signal), flush=True)

        logger.info("FAISS server ready, waiting for requests...")

        # Process requests from stdin
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue

            try:
                request = json.loads(line)
                request_id = request.get('request_id')
                method = request.get('method')
                params = request.get('params', {})

                # Handle shutdown
                if method == 'shutdown':
                    server.save()
                    send_response(request_id, {"success": True})
                    break

                # Dispatch method
                if method == 'search':
                    result = server.search(
                        params['embedding'],
                        params.get('threshold', 0.4)
                    )
                    send_response(request_id, result)

                elif method == 'batch_search':
                    result = server.batch_search(
                        params['embeddings'],
                        params.get('threshold', 0.4)
                    )
                    send_response(request_id, result)

                elif method == 'add_face':
                    result = server.add_face(
                        params['embedding'],
                        params['name']
                    )
                    send_response(request_id, result)

                elif method == 'add_faces_batch':
                    result = server.add_faces_batch(
                        params['embeddings'],
                        params['names']
                    )
                    send_response(request_id, result)

                elif method == 'search_similar':
                    result = server.search_similar(
                        params['embedding'],
                        params.get('k', 10),
                        params.get('threshold', 0.4)
                    )
                    send_response(request_id, result)

                elif method == 'save':
                    success = server.save()
                    send_response(request_id, {"success": success})

                elif method == 'get_stats':
                    result = server.get_stats()
                    send_response(request_id, result)

                elif method == 'rename_person':
                    result = server.rename_person(
                        params['old_name'],
                        params['new_name']
                    )
                    send_response(request_id, result)

                elif method == 'remove_person':
                    result = server.remove_person(params['name'])
                    send_response(request_id, result)

                else:
                    send_response(request_id, error=f"Unknown method: {method}")

            except Exception as e:
                logger.error(f"Error processing request: {e}", exc_info=True)
                if 'request_id' in locals():
                    send_response(request_id, error=str(e))

    except Exception as e:
        logger.error(f"Fatal error: {e}", exc_info=True)
        sys.exit(1)


if __name__ == "__main__":
    main()
