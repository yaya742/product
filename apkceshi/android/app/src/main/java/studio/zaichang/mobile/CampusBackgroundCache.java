package studio.zaichang.mobile;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.KeyStore;
import java.security.SecureRandom;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/** Encrypted-at-rest storage for the last successful background campus read. */
final class CampusBackgroundCache {
    private static final String KEY_ALIAS = "studio.zaichang.mobile.campus-cache.v1";
    private static final String PREFERENCES = "zaichang_campus_cache";
    private static final String SNAPSHOT_KEY = "snapshot";
    private static final int IV_BYTES = 12;
    private static final int TAG_BITS = 128;
    private static final int MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024;

    private CampusBackgroundCache() {}

    private static SharedPreferences preferences(Context context) {
        return context.getApplicationContext().getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE);
    }

    private static SecretKey key() throws GeneralSecurityException {
        try {
            KeyStore store = KeyStore.getInstance("AndroidKeyStore");
            store.load(null);
            if (store.containsAlias(KEY_ALIAS)) return (SecretKey) store.getKey(KEY_ALIAS, null);
            KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
            generator.init(new KeyGenParameterSpec.Builder(
                    KEY_ALIAS,
                    KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .setRandomizedEncryptionRequired(true)
                    .build());
            return generator.generateKey();
        } catch (Exception error) {
            throw new GeneralSecurityException("campus_cache_key_unavailable", error);
        }
    }

    private static String encrypt(String value) throws GeneralSecurityException {
        byte[] plaintext = value.getBytes(StandardCharsets.UTF_8);
        if (plaintext.length > MAX_SNAPSHOT_BYTES) throw new GeneralSecurityException("campus_snapshot_too_large");
        byte[] iv = new byte[IV_BYTES];
        new SecureRandom().nextBytes(iv);
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, key(), new GCMParameterSpec(TAG_BITS, iv));
        byte[] ciphertext = cipher.doFinal(plaintext);
        return Base64.encodeToString(iv, Base64.NO_WRAP) + "." + Base64.encodeToString(ciphertext, Base64.NO_WRAP);
    }

    private static String decrypt(String encoded) throws GeneralSecurityException {
        String[] parts = encoded.split("\\.", -1);
        if (parts.length != 2) throw new GeneralSecurityException("invalid_campus_snapshot");
        byte[] iv = Base64.decode(parts[0], Base64.NO_WRAP);
        byte[] ciphertext = Base64.decode(parts[1], Base64.NO_WRAP);
        if (iv.length != IV_BYTES || ciphertext.length > MAX_SNAPSHOT_BYTES + 32) {
            throw new GeneralSecurityException("invalid_campus_snapshot_size");
        }
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(TAG_BITS, iv));
        return new String(cipher.doFinal(ciphertext), StandardCharsets.UTF_8);
    }

    static void write(Context context, String snapshot) throws GeneralSecurityException {
        if (!preferences(context).edit().putString(SNAPSHOT_KEY, encrypt(snapshot)).commit()) {
            throw new GeneralSecurityException("campus_snapshot_write_failed");
        }
    }

    static String read(Context context) throws GeneralSecurityException {
        String encoded = preferences(context).getString(SNAPSHOT_KEY, null);
        return encoded == null ? null : decrypt(encoded);
    }

    static void clear(Context context) {
        preferences(context).edit().remove(SNAPSHOT_KEY).commit();
    }
}
