package studio.zaichang.mobile;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.KeyStore;
import java.security.SecureRandom;
import java.util.regex.Pattern;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

@CapacitorPlugin(name = "SecureStorage")
public class SecureStoragePlugin extends Plugin {
    private static final String KEY_ALIAS = "studio.zaichang.mobile.secure-storage.v1";
    private static final String PREFERENCES = "zaichang_secure_storage";
    private static final int IV_BYTES = 12;
    private static final int TAG_BITS = 128;
    private static final int MAX_VALUE_LENGTH = 4096;
    private static final Pattern SAFE_KEY = Pattern.compile("[A-Za-z0-9._-]{1,80}");

    private static SharedPreferences preferences(Context context) {
        return context.getApplicationContext().getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE);
    }

    private static void requireKey(String key) throws GeneralSecurityException {
        if (key == null || !SAFE_KEY.matcher(key).matches()) {
            throw new GeneralSecurityException("invalid_secure_storage_key");
        }
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
            throw new GeneralSecurityException("secure_storage_key_unavailable", error);
        }
    }

    private static String encrypt(String value) throws GeneralSecurityException {
        if (value.length() > MAX_VALUE_LENGTH) throw new GeneralSecurityException("secure_storage_value_too_large");
        byte[] iv = new byte[IV_BYTES];
        new SecureRandom().nextBytes(iv);
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, key(), new GCMParameterSpec(TAG_BITS, iv));
        byte[] ciphertext = cipher.doFinal(value.getBytes(StandardCharsets.UTF_8));
        return Base64.encodeToString(iv, Base64.NO_WRAP) + "." + Base64.encodeToString(ciphertext, Base64.NO_WRAP);
    }

    private static String decrypt(String encoded) throws GeneralSecurityException {
        String[] parts = encoded.split("\\.", -1);
        if (parts.length != 2) throw new GeneralSecurityException("invalid_secure_storage_value");
        byte[] iv = Base64.decode(parts[0], Base64.NO_WRAP);
        byte[] ciphertext = Base64.decode(parts[1], Base64.NO_WRAP);
        if (iv.length != IV_BYTES) throw new GeneralSecurityException("invalid_secure_storage_iv");
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(TAG_BITS, iv));
        return new String(cipher.doFinal(ciphertext), StandardCharsets.UTF_8);
    }

    public static String readStored(Context context, String key) throws GeneralSecurityException {
        requireKey(key);
        String encoded = preferences(context).getString(key, null);
        return encoded == null ? null : decrypt(encoded);
    }

    public static void writeStored(Context context, String key, String value) throws GeneralSecurityException {
        requireKey(key);
        if (value == null || value.isEmpty()) {
            preferences(context).edit().remove(key).apply();
            return;
        }
        preferences(context).edit().putString(key, encrypt(value)).apply();
    }

    private static String requiredString(PluginCall call, String name) throws GeneralSecurityException {
        String value = call.getString(name);
        if (value == null) throw new GeneralSecurityException("missing_secure_storage_" + name);
        return value;
    }

    private static String safeErrorType(Exception error) {
        Throwable root = error;
        for (int depth = 0; depth < 8 && root.getCause() != null && root.getCause() != root; depth++) {
            root = root.getCause();
        }
        String name = root.getClass().getSimpleName().replaceAll("[^A-Za-z0-9]", "");
        return name.isEmpty() ? "Unknown" : name;
    }

    @PluginMethod
    public void get(PluginCall call) {
        try {
            String key = requiredString(call, "key");
            String value = readStored(getContext(), key);
            JSObject result = new JSObject();
            if (value != null) result.put("value", value);
            call.resolve(result);
        } catch (Exception error) {
            call.reject("secure_storage_get_failed:" + safeErrorType(error), "secure_storage_get_failed");
        }
    }

    @PluginMethod
    public void set(PluginCall call) {
        try {
            String key = requiredString(call, "key");
            String value = requiredString(call, "value");
            writeStored(getContext(), key, value);
            call.resolve();
        } catch (Exception error) {
            call.reject("secure_storage_set_failed:" + safeErrorType(error), "secure_storage_set_failed");
        }
    }

    @PluginMethod
    public void remove(PluginCall call) {
        try {
            String key = requiredString(call, "key");
            requireKey(key);
            preferences(getContext()).edit().remove(key).apply();
            call.resolve();
        } catch (Exception error) {
            call.reject("secure_storage_remove_failed:" + safeErrorType(error), "secure_storage_remove_failed");
        }
    }

    @PluginMethod
    public void clear(PluginCall call) {
        preferences(getContext()).edit().clear().apply();
        call.resolve();
    }
}
